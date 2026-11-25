// OPT-E04a：main.ts 的平台发布循环拆出模块。
// 发布锁实例归本模块所有，platform-loop 通过同一实例判断占用；跨域客户端注入。
import { app } from 'electron';
import { safeConsoleError } from '../stdio-guard';
import { PublishTaskClient } from '../publish-task-client';
import { runDesktopPublishTask } from '../publish/executor';
import { PublishLoopLock } from '../publish-loop-lock';
import { createDefaultDesktopPublishAdapterRegistry } from '../publish/registry';
import type { BrowserPolicyGate } from '../publish/types';
import type { DesktopPublishAdapterRegistry } from '../publish/registry';
import { openDesktopPublishPage } from '../publish-page';
import type { DesktopClient } from '../desktop-client';
import { describeError } from './platform-collect';

export interface PublishLoopDeps {
  getDesktopClient(): DesktopClient | null;
  getServiceNamespace(): string;
  isPlatformLoginActive(): boolean;
  isCollectInFlight(): boolean;
}

let deps: PublishLoopDeps | null = null;
let serviceNamespace = '';

export function configurePublishLoop(next: PublishLoopDeps): void {
  deps = next;
  serviceNamespace = next.getServiceNamespace();
}

function requireDeps(): PublishLoopDeps {
  if (!deps) throw new Error('发布循环模块尚未初始化。');
  // serviceNamespace 在启动时解析，可能晚于首次 configure；这里按注入 getter 刷新。
  serviceNamespace = deps.getServiceNamespace();
  return deps;
}

// 发布任务与采集共用同一个平台 profile，必须互斥；否则两个浏览器会争用 profile 锁。
// 锁带超时：发布页面/心跳/回执任一挂起时，下一轮 tick 能强制释放并关闭旧页面，
// 不让采集被一个卡死的发布任务永久挡住。
export const publishLock = new PublishLoopLock();
let publishPageSession: Awaited<ReturnType<typeof openDesktopPublishPage>> | null = null;

export function isPublishLockHeld(): boolean {
  return publishLock.isHeld();
}

// REF41 P2：发布任务领取循环。与采集分开 schedule，但共用 profile，所以用
// collectInFlight/publishLock 互斥；同一时刻只有一个浏览器能打开该账号目录。
// 这里只做真实 claim → heartbeat → 页面身份核对 → result，不填内容、不点发布。
const PUBLISH_CLAIM_INTERVAL_MS = 30_000;
let publishTimer: NodeJS.Timeout | null = null;

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code.slice(0, 80);
  return 'desktop_publish_failed';
}

function stopStuckPublishSession(): boolean {
  if (!publishLock.isExpired()) return false;
  const releasedToken = publishLock.forceRelease();
  const stuck = publishPageSession;
  publishPageSession = null;
  safeConsoleError('[publish-auto] 发布互斥锁超时，强制释放', JSON.stringify({ releasedToken }));
  if (stuck) {
    // 先杀浏览器子进程，再关闭页面；这样即使 close() 自身挂起，profile 也能释放。
    if (stuck.browser.child.exitCode === null) stuck.browser.child.kill();
    void stuck.close().catch(() => undefined);
  }
  return true;
}

export function startPlatformPublishLoop(): void {
  if (publishTimer) return;
  const d = requireDeps();
  const tick = async () => {
    const desktopClient = d.getDesktopClient();
    // 上一轮发布卡在页面/网络调用里时，下一轮 tick 负责收尸；不能永久占着互斥锁。
    // 本轮只收尸，不再立即 claim，给旧浏览器进程留出退出时间。
    if (stopStuckPublishSession()) return;
    if (d.isCollectInFlight() || publishLock.isHeld() || !desktopClient) return;
    if (d.isPlatformLoginActive()) return;
    const token = publishLock.acquire();
    if (token === null) return;
    let pageSession: Awaited<ReturnType<typeof openDesktopPublishPage>> | null = null;
    let client: PublishTaskClient | null = null;
    try {
      const capability = await desktopClient.getPlatformCollectionCapability();
      if (!publishLock.owns(token)) return;
      if (!capability.enabled) return;
      client = new PublishTaskClient(capability, async (operation, method, path, body) =>
        desktopClient!.platformSignedCall(operation, method, path, body));
      const claimed = await client.claim();
      if (!publishLock.owns(token)) return;
      if (!claimed) return;
      client.adopt(claimed);
      safeConsoleError('[publish-auto] 领到任务', JSON.stringify({
        platform: claimed.platform,
        taskId: claimed.taskId,
        mode: claimed.mode,
        manifestRevision: claimed.manifestRevision
      }));

      let registry: DesktopPublishAdapterRegistry;
      if (claimed.platform === 'xhs' || claimed.platform === 'toutiao') {
        const auth = await desktopClient.getAuthContext();
        if (!publishLock.owns(token)) return;
        pageSession = await openDesktopPublishPage({
          userDataDir: app.getPath('userData'),
          scope: {
            origin: serviceNamespace,
            userId: auth.userId,
            workspaceId: auth.workspaceId,
            deviceId: auth.deviceId,
            accountId: claimed.accountId,
            platform: claimed.platform
          },
          platform: claimed.platform,
          accountName: claimed.accountName ?? '',
          externalAccountKey: claimed.externalAccountKey,
          taskId: claimed.taskId,
          assets: claimed.assets
        });
        if (!publishLock.owns(token)) {
          if (pageSession.browser.child.exitCode === null) pageSession.browser.child.kill();
          void pageSession.close().catch(() => undefined);
          pageSession = null;
          return;
        }
        publishPageSession = pageSession;
        const policy: BrowserPolicyGate = {
          check: (input) => client!.checkBrowserPolicy(input),
        };
        registry = createDefaultDesktopPublishAdapterRegistry(pageSession.port, policy);
      } else {
        // 没有页面适配器的平台也要如实回执 executor_not_registered，不能把任务卡在 filling。
        registry = createDefaultDesktopPublishAdapterRegistry({
          currentAccountName: async () => claimed.accountName ?? '',
          hasAnchor: async () => false
        });
      }

      const result = await runDesktopPublishTask({
        claim: async () => claimed,
        heartbeat: async () => {
          await client!.heartbeat();
          safeConsoleError('[publish-auto] heartbeat ok', claimed.taskId);
        },
        result: async (_taskId, payload) => {
          // P6-A3：真实点击成功后，服务端仍要求作品里程碑已是 submitted。
          // 先走官方发布进度接口登记交接，再回写任务；不让桌面证明绕过里程碑。
          if (claimed.intent === 'submit' && payload.state === 'submitted' && desktopClient) {
            await desktopClient.recordWorkSubmitted(claimed.workId, '桌面立即提交：已在平台页面点击发布');
          }
          await client!.result(payload);
        },
        registry
      });
      safeConsoleError('[publish-auto] 完成', JSON.stringify({
        state: result?.state ?? null,
        errorCode: result?.errorCode ?? null
      }));
    } catch (error) {
      safeConsoleError('[publish-auto] 循环异常', describeError(error));
      if (client?.claimed()) {
        await client.result({
          state: 'failed',
          errorCode: errorCodeOf(error),
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500)
        }).catch(() => undefined);
      }
    } finally {
      // 正常路径先等页面关闭（最多 5 秒），再释放锁；close 卡住则杀进程后释放。
      if (pageSession) {
        await Promise.race([
          pageSession.close().catch(() => undefined),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          })
        ]);
        if (pageSession.browser.child.exitCode === null) pageSession.browser.child.kill();
      }
      if (publishLock.release(token) && publishPageSession === pageSession) {
        publishPageSession = null;
      }
    }
  };
  publishTimer = setInterval(() => void tick(), PUBLISH_CLAIM_INTERVAL_MS);
  publishTimer.unref?.();
}

export function stopPlatformPublishLoop(): void {
  if (!publishTimer) return;
  clearInterval(publishTimer);
  publishTimer = null;
}
