// 将分步登录接到既有 profile、浏览器/CDP 和服务端连接协议；不收集作品。
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPageResponseSource, PLATFORM_LOGIN_URLS, probeIdentity, type PlatformLoginPlatform, type PlatformLoginSession } from './platform-login';
import { accountProfileSlot, buildProfileMeta, checkQuota, readAccountProfile, saveAccountProfile, type AccountProfileMeta, type AccountProfileScope } from './platform-profile';
import { selectLoginBrowser, trustedLoginBrowsers, type LoginBrowserFamily } from './platform-browser-trust';
import { createCDPClient, launchPlatformBrowser, PLATFORM_BROWSER_NAMES, PlatformBrowserError, isAllowedPlatformUrl } from './platform-worker';
import { installLoginNavigationPolicy } from './platform-login-policy';
import { parseIdentity as parseXhsIdentity, probeCapabilities as xhsCapabilities, probePostedNotesReadable } from './platforms/xhs';
import { parseIdentity as parseWechatIdentity, probeCapabilities as wechatCapabilities } from './platforms/wechat-mp';
import type { LoginHandle, LoginIdentity } from './platform-login-flow';
import type { DesktopClient } from './desktop-client';

const locks = new Set<string>();
interface RuntimeHandle extends LoginHandle { profileDir: string; meta: AccountProfileMeta }

export async function probeXhsLoginIdentity(session: PlatformLoginSession, expectedKey: string | null, browserVersion: string, now: string): Promise<LoginIdentity | null> {
  const result = await probeIdentity(session);
  if (!result.loggedIn || !result.payload) return null;
  const identity = parseXhsIdentity(JSON.parse(result.payload));
  let postedNotesReadable = false;
  // A recheck must never read the works of an account different from the existing connection.
  if (!expectedKey || expectedKey === identity.externalAccountKey) {
    try {
      await probePostedNotesReadable(createPageResponseSource(session));
      postedNotesReadable = true;
    } catch {
      // Identity can still be reviewed while an unverified catalog remains closed.
    }
  }
  return {
    externalAccountKey: identity.externalAccountKey,
    displayName: identity.redId || identity.externalAccountKey,
    capabilities: {
      ...xhsCapabilities({ mainSiteLoggedIn: true, identity, postedNotesReadable, followerInfoReadable: false, now }),
      workList: postedNotesReadable ? 'supported' : 'unknown',
      perNoteMetrics: 'unknown',
      followerTotal: 'unknown',
      browserVersion
    }
  };
}

export async function startPlatformLogin(client: DesktopClient, userData: string, scope: AccountProfileScope, family?: LoginBrowserFamily, operationId: string = randomUUID()): Promise<LoginHandle> {
  const stored = await readAccountProfile(userData, scope);
  if (family && stored.meta && family !== stored.meta.browserFamily) throw new PlatformBrowserError('platform_browser_mismatch', '连接已固定到另一浏览器，请继续使用原浏览器');
  if (locks.has(stored.profileDir)) throw new PlatformBrowserError('platform_profile_busy', '该账号的专用窗口已被占用');
  locks.add(stored.profileDir);
  let close = async () => { locks.delete(stored.profileDir); };
  try {
    if (!(await checkQuota(userData, scope.userId)).ok) throw new PlatformBrowserError('platform_profile_quota', '本机会话空间不足，请先清理');
    const candidates = await trustedLoginBrowsers();
    const browserCandidate = selectLoginBrowser(candidates, stored.meta?.browserFamily ?? family);
    const browserFamily = browserCandidate.family as LoginBrowserFamily;
    const slotId = accountProfileSlot(scope);
    const meta: AccountProfileMeta = { ...(stored.meta ?? { ...buildProfileMeta({ ...scope, connectionId: slotId, externalAccountKey: '' }), origin: new URL(scope.origin).origin, slotId, accountId: scope.accountId, browserFamily }), loginOperationId: operationId };
    await saveAccountProfile(userData, stored.profileDir, meta);
    await fs.mkdir(stored.profileDir, { recursive: true, mode: 0o700 });
    const browser = await launchPlatformBrowser({ executablePath: browserCandidate.executablePath, profileDir: stored.profileDir });
    const cdp = createCDPClient(browser, 15_000);
    let removePolicy = () => {};
    let removeCapture = () => {};
    let closing: Promise<void> | undefined;
    browser.child.once('exit', () => { locks.delete(stored.profileDir); });
    close = () => {
      if (browser.child.exitCode !== null) { locks.delete(stored.profileDir); removeCapture(); removePolicy(); return Promise.resolve(); }
      return closing ??= (async () => {
      removeCapture(); removePolicy();
      await cdp.close();
      if (browser.child.exitCode === null) throw new PlatformBrowserError('platform_cleanup_pending', '专用浏览器尚未完全退出');
      locks.delete(stored.profileDir);
      })().finally(() => { closing = undefined; });
    };
    await cdp.attachToPage();
    removePolicy = await installLoginNavigationPolicy(cdp, scope.platform, () => { void close().catch(() => undefined); });
    const version = await cdp.request('Browser.getVersion') as { product?: string };
    const browserVersion = String(version.product ?? '').slice(0, 80);
    let wechatPayload: unknown;
    const ids = new Set<string>();
    removeCapture = cdp.onEvent((method, raw) => {
      if (scope.platform !== 'wechat_mp') return;
      const data = raw as { requestId?: string; response?: { url?: string; status?: number } };
      if (method === 'Network.responseReceived' && data.requestId && data.response?.status === 200) {
        try {
          const url = new URL(data.response.url ?? '');
          if (url.origin === 'https://mp.weixin.qq.com' && url.pathname === '/cgi-bin/switchacct') ids.add(data.requestId);
        } catch { /* 非 URL 响应不用于身份。 */ }
      }
      if (method === 'Network.loadingFinished' && data.requestId && ids.delete(data.requestId)) {
        void cdp.request('Network.getResponseBody', { requestId: data.requestId }).then((result) => {
          const response = result as { body?: string; base64Encoded?: boolean };
          if (!response.base64Encoded && typeof response.body === 'string' && response.body.length <= 65536) wechatPayload = JSON.parse(response.body);
        }).catch(() => undefined);
      }
    });
    await cdp.request('Network.enable');
    await cdp.request('Page.enable');
    await cdp.request('Page.navigate', { url: PLATFORM_LOGIN_URLS[scope.platform as PlatformLoginPlatform] });
    // 不因能力接口缺头条而阻止本人打开固定官方页；但不允许虚构服务端连接。
    const capability = await client.getPlatformCollectionCapability().catch(() => null);
    const supported = scope.platform !== 'toutiao' && capability?.enabled === true && capability.platforms.includes(scope.platform);
    const connection = supported ? await findOwnedConnection(client, scope) : null;
    const expectedKey = connection ? String(connection.external_account_key) : meta.externalAccountKey || null;
    const handle: RuntimeHandle = {
      profileDir: stored.profileDir, meta, browserFamily, browserVersion,
      supported, expectedKey,
      close,
      onClosed(callback) { browser.child.once('exit', callback); if (browser.child.exitCode !== null) callback(); },
      async show() { await cdp.request('Page.bringToFront'); },
      async probe() {
        if (!supported) throw new PlatformBrowserError('platform_capability_denied', '身份能力尚未验证，请继续人工回填');
        const frame = await cdp.request('Page.getFrameTree') as { frameTree?: { frame?: { url?: string } } };
        if (!isAllowedPlatformUrl(frame.frameTree?.frame?.url ?? '', scope.platform)) throw new PlatformBrowserError('platform_login_required', '请先完成官方登录');
        const now = new Date().toISOString();
        if (scope.platform === 'wechat_mp') {
          if (!wechatPayload) return null;
          // 只接受官方页面明确暴露且符合原始ID格式的当前主体；不存在时多账号拒绝猜测。
          const current = await cdp.request('Runtime.evaluate', { expression: `(() => { const id = globalThis.wx?.data?.user_name; return typeof id === 'string' && /^gh_[0-9a-zA-Z]+$/.test(id) ? id : null; })()`, returnByValue: true }) as { result?: { value?: unknown } };
          const identity = parseWechatIdentity(wechatPayload, typeof current.result?.value === 'string' ? current.result.value : undefined);
          return { externalAccountKey: identity.externalAccountKey, displayName: identity.originalID, capabilities: { ...wechatCapabilities({ backendLoggedIn: true, identity, listReadable: false, now }), publishedList: 'unknown', perArticleMetrics: 'unknown', browserVersion } };
        }
        const session: PlatformLoginSession = { platform: 'xhs', profileDir: stored.profileDir, browser, cdp };
        return probeXhsLoginIdentity(session, expectedKey, browserVersion, now);
      }
    };
    return handle;
  } catch (error) { await close().catch(() => undefined); throw error; }
}

export async function findOwnedConnection(client: DesktopClient, scope: AccountProfileScope): Promise<Record<string, unknown> | null> {
  const rows = (await client.listPlatformConnections()).filter((row) => row.account_id === scope.accountId && row.workspace_id === scope.workspaceId && row.state !== 'revoked');
  if (rows.length > 1) throw new PlatformBrowserError('platform_connection_conflict', '该账号存在连接冲突');
  const row = rows[0];
  if (!row) return null;
  if (row.user_id !== scope.userId || row.device_id !== scope.deviceId || row.platform !== scope.platform) throw new PlatformBrowserError('platform_connection_conflict', '该连接属于其他用户或设备');
  return row;
}

export async function savePlatformLogin(client: DesktopClient, userData: string, scope: AccountProfileScope, identity: LoginIdentity, rawHandle: LoginHandle, recoverOnly: boolean, signal: AbortSignal): Promise<{ id: string; autoCollect: boolean; autoAdopt: boolean }> {
  const handle = rawHandle as RuntimeHandle;
  const assertCurrent = async () => {
    const current = await client.getAuthContext();
    if (signal.aborted || current.userId !== scope.userId || current.workspaceId !== scope.workspaceId || current.deviceId !== scope.deviceId) throw new PlatformBrowserError('platform_login_context_changed', '当前登录上下文已变化');
  };
  await assertCurrent();
  let connection = await findOwnedConnection(client, scope);
  if (connection && connection.external_account_key !== identity.externalAccountKey) throw new PlatformBrowserError('platform_identity_mismatch', '当前平台账号与原连接不一致');
  if (connection && (connection.state !== 'active' || ['restricted', 'challenge_required'].includes(String(connection.availability)))) throw new PlatformBrowserError('platform_risk_paused', '原连接已暂停，请按原恢复流程处理');
  if (!connection) {
    if (recoverOnly) throw new PlatformBrowserError('platform_connection_unconfirmed', '暂未查到原连接，不能重复创建');
    await assertCurrent();
    connection = await client.createPlatformConnection({ accountId: scope.accountId, externalAccountKey: identity.externalAccountKey, consentVersion: 1 });
  }
  const id = typeof connection.id === 'string' ? connection.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PlatformBrowserError('platform_connection_unconfirmed', '服务端没有返回有效连接');
  await assertCurrent();
  // 首次成功只原子接管映射，不移动活跃 profile。取消的晚到回执在服务端查询恢复。
  handle.meta = { ...handle.meta, connectionId: id, externalAccountKey: identity.externalAccountKey };
  await saveAccountProfile(userData, handle.profileDir, handle.meta, handle.meta.loginOperationId, signal);
  await assertCurrent();
  const verified = await client.verifyPlatformConnection({ connectionId: id, externalAccountKey: identity.externalAccountKey, capabilities: identity.capabilities });
  if (verified.id !== id || verified.external_account_key !== identity.externalAccountKey || verified.availability !== 'ready') throw new PlatformBrowserError('platform_connection_unconfirmed', '连接尚未收到验证成功回执');
  return { id, autoCollect: verified.auto_collect === true, autoAdopt: verified.auto_adopt === true };
}

export const loginBrowserLabel = (family: LoginBrowserFamily): string => PLATFORM_BROWSER_NAMES[family];
