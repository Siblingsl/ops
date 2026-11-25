// OPT-E04a：main.ts 的平台 presence / claim / 发布 / 竞对观测循环拆出模块。
// 定时器与单飞状态由本模块持有；跨域客户端与健康状态回调由 main.ts 注入。
import type { DesktopClient } from '../desktop-client';
import { safeConsoleError } from '../stdio-guard';
import { BenchmarkObserveClient } from '../benchmark-observe-client';
import { readPublicBenchmarkTask } from '../benchmark-observe-page';
import { failedPublicNote } from '../benchmark-observe';
import { PlatformClient, type PlatformClaimedRun } from '../platform-client';
import { PlatformBrowserError } from '../platform-worker';
import { describeError, runPlatformCollect } from './platform-collect';
import { publishLock } from './publish-loop';

export interface PlatformLoopDeps {
  getDesktopClient(): DesktopClient | null;
  isPlatformLoginActive(): boolean;
  setPresenceHealth(status: 'unknown' | 'online' | 'offline' | 'error', message: string): void;
  setCollectionHealth(status: 'idle' | 'running' | 'partial' | 'failed', message: string): void;
}

let deps: PlatformLoopDeps | null = null;

export function configurePlatformLoop(next: PlatformLoopDeps): void {
  deps = next;
}

function requireDeps(): PlatformLoopDeps {
  if (!deps) throw new Error('平台循环模块尚未初始化。');
  return deps;
}

const PLATFORM_PRESENCE_INTERVAL_MS = 30_000;

let presenceTimer: NodeJS.Timeout | null = null;
let presenceInFlight = false;
let presenceLastError: string | null = null;

// startPlatformPresence 启动心跳。重复调用是幂等的。
export function startPlatformPresence(): void {
  if (presenceTimer) return;
  const d = requireDeps();
  const tick = async () => {
    const desktopClient = d.getDesktopClient();
    if (presenceInFlight || !desktopClient) return;
    presenceInFlight = true;
    try {
      const capability = await desktopClient.getPlatformCollectionCapability();
      if (!capability.enabled) {
        // 服务端未开通平台采集：不发 presence，也把错误状态清掉。
        presenceLastError = null;
        d.setPresenceHealth('offline', '自动采集尚未启用。');
        return;
      }
      await desktopClient.presence();
      d.setPresenceHealth('online', '平台采集服务在线。');
      if (presenceLastError) {
        // 从失败恢复时记一条，便于排查"为什么之前一直离线"。
        safeConsoleError('[platform-presence] 已恢复上报');
        presenceLastError = null;
      }
    } catch (error) {
      // 静默失败：不弹窗、不打断用户。只在首次或错误变化时记一条，避免日志被刷满。
      const code = error instanceof PlatformBrowserError ? error.code : 'presence_failed';
      const codeText = code;
      if (presenceLastError !== codeText) {
        presenceLastError = codeText;
        safeConsoleError('[platform-presence] 上报失败', codeText, describeError(error));
      }
      d.setPresenceHealth('error', '平台连接状态暂不可用，请检查账号登录情况。');
    } finally {
      presenceInFlight = false;
    }
  };
  // 立即发一次：不要等 30 秒，否则刚启动的客户端在调度眼里仍是离线。
  void tick();
  presenceTimer = setInterval(() => void tick(), PLATFORM_PRESENCE_INTERVAL_MS);
  // 心跳不应阻止进程退出。
  presenceTimer.unref?.();
}

// stopPlatformPresence 停止心跳（应用退出或平台开关关闭时）。
export function stopPlatformPresence(): void {
  if (!presenceTimer) return;
  clearInterval(presenceTimer);
  presenceTimer = null;
}

// ---------- 后台任务循环（DEV-PS34 / 20 文档 §5.2、§10.1.1） ----------
//
// 光有 presence 心跳还不够：文档 §5.2 说"每 30 秒发 presence，否则空闲连接永远等不到新任务"，
// 但 presence 只让服务端认为设备在线；任务要**客户端主动 claim** 才会被执行。
// 原来 claim 只在用户点"开始采集"时调用一次，因此自动生成的任务会一直 queued 到超时。
//
// 这里的循环：每 30 秒尝试 claim 一次；领到就执行，没领到就等下一轮。
// 约束：同一时刻只跑一个采集（浏览器与 profile 不能并发），已经在采时跳过本轮。

const PLATFORM_CLAIM_INTERVAL_MS = 30_000;

let claimTimer: NodeJS.Timeout | null = null;
let claimRetryTimer: NodeJS.Timeout | null = null;
let collectInFlight = false;

export function isCollectInFlight(): boolean {
  return collectInFlight;
}

// startPlatformClaimLoop 启动后台领取循环。重复调用幂等。
export function startPlatformClaimLoop(): void {
  if (claimTimer) return;
  const d = requireDeps();
  // 发布循环先注册，且与采集循环同为 30 秒。两个定时器在同一时刻唤醒时，
  // 发布 tick 会先持锁；采集 tick 若直接 return，就会每个周期都撞上发布锁，
  // 表现为“服务在线但永远没有任务”。这里在锁被占用时短延迟重试，而不是等下一轮。
  const scheduleClaimRetry = () => {
    if (claimRetryTimer) return;
    claimRetryTimer = setTimeout(() => {
      claimRetryTimer = null;
      void tick();
    }, 3_000);
    claimRetryTimer.unref?.();
  };
  const tick = async () => {
    const desktopClient = d.getDesktopClient();
    if (collectInFlight || !desktopClient) return;
    if (publishLock.isHeld()) {
      scheduleClaimRetry();
      return;
    }
    if (d.isPlatformLoginActive()) return; // 登录中不抢 profile
    collectInFlight = true;
    try {
      const capability = await desktopClient.getPlatformCollectionCapability();
      if (!capability.enabled) {
        d.setCollectionHealth('idle', '自动采集尚未启用。');
        return;
      }
      const client = new PlatformClient(capability, async (operation, method, path, body) =>
        desktopClient!.platformSignedCall(operation, method, path, body));
      const run = await client.claim();
      if (!run) {
        d.setCollectionHealth('idle', '自动采集服务在线，正在等待任务。');
        return;
      }
      d.setCollectionHealth('running', '正在采集平台作品。');
      safeConsoleError('[platform-auto] 领到任务', JSON.stringify({ platform: run.platform, taskKind: run.task_kind }));
      const outcome = await runPlatformCollect(run.account_id, run);
      safeConsoleError('[platform-auto] 完成', JSON.stringify({
        runStatus: outcome.runStatus, accepted: outcome.accepted,
        rejected: outcome.rejected, errorCode: outcome.errorCode,
        // 投影失败时把原因一并记下。不记的话，日志里只有"完成"，而数据其实没进正式指标。
        adoptErrors: outcome.adoptErrors, adoptReason: outcome.adoptReason
      }));
      // PB-11：采集成功但正式指标未写入时，在桌面状态栏给出可见提醒。
      if (outcome.adoptErrors > 0) {
        d.setCollectionHealth('partial', `${outcome.adoptErrors} 条观测未写入正式指标，请在平台连接设置中逐条确认。`);
      } else if (outcome.runStatus === 'failed') {
        d.setCollectionHealth('failed', '平台采集未能完成，请检查网络和平台连接设置后重试。');
      } else {
        d.setCollectionHealth('idle', '自动采集已完成。');
      }
      // 自动采用失败要单独告警：这是"采集成功但数据没进正式指标"的静默失败，
      // 靠一行 JSON 容易被忽略，所以再打一条明确的中文提示。
      if (outcome.adoptErrors > 0) {
        safeConsoleError(
          `[platform-auto] 有 ${outcome.adoptErrors} 条观测已采集但未写入正式指标，原因：${outcome.adoptReason ?? '未知'}。` +
          '请在平台连接卡片里逐条确认。'
        );
      }
    } catch (error) {
      // PB-09：自动采集循环失败时显示概括原因，不把内部错误码暴露给用户。
      safeConsoleError('[platform-auto] 循环异常', describeError(error));
      d.setCollectionHealth('failed', '自动采集最近失败，请检查网络和平台连接设置后重试。');
    } finally {
      collectInFlight = false;
    }
  };
  claimTimer = setInterval(() => void tick(), PLATFORM_CLAIM_INTERVAL_MS);
  claimTimer.unref?.();
}

export function stopPlatformClaimLoop(): void {
  if (claimRetryTimer) {
    clearTimeout(claimRetryTimer);
    claimRetryTimer = null;
  }
  if (!claimTimer) return;
  clearInterval(claimTimer);
  claimTimer = null;
}

// REF41 I1-A5：竞对公开页观测循环。与平台采集 profile 完全隔离：不登录、不带
// Cookie、不用 persistent partition；claim 到任务后用隐藏窗口只读公开页，解析结果
// 走 benchmark.observe.result 写回。默认 30 秒一轮，与平台采集的 30 秒互不抢占。
const BENCHMARK_OBSERVE_INTERVAL_MS = (() => {
  const raw = Number(process.env.OPS_BENCHMARK_OBSERVE_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 30_000;
})();

let benchmarkObserveTimer: NodeJS.Timeout | null = null;
let benchmarkObserveInFlight = false;

export function startBenchmarkObserveLoop(): void {
  if (benchmarkObserveTimer) return;
  const d = requireDeps();
  const tick = async () => {
    const desktopClient = d.getDesktopClient();
    if (benchmarkObserveInFlight || !desktopClient) return;
    if (d.isPlatformLoginActive()) return; // 登录流程独占本机窗口资源
    benchmarkObserveInFlight = true;
    try {
      const capability = await desktopClient.getPlatformCollectionCapability();
      if (!capability.enabled || !capability.operations.includes('benchmark.observe.claim')) return;
      const client = new BenchmarkObserveClient(async (operation, method, path, body) =>
        desktopClient!.platformSignedCall(operation, method, path, body));
      const task = await client.claim();
      if (!task) return;
      safeConsoleError('[benchmark-observe] 领到任务', JSON.stringify({ platform: task.platform, target: task.url }));
      const heartbeat = setInterval(() => {
        void client.heartbeat(task).catch((error) => {
          safeConsoleError('[benchmark-observe] 心跳失败', describeError(error));
        });
      }, 15_000);
      heartbeat.unref?.();
      try {
        const note = await readPublicBenchmarkTask(task, {
          allowLocal: process.env.OPS_BENCHMARK_ALLOW_LOCAL === '1',
          timeoutMs: 20_000,
          settleMs: 600
        });
        await client.results(task, note);
        safeConsoleError('[benchmark-observe] 已提交', JSON.stringify({
          externalId: note.externalId, quality: note.quality, metrics: Object.keys(note.values).length,
          errorCode: note.errorCode ?? null
        }));
      } catch (error) {
        // 页面读取/提交失败也要落一条 failed 观测，不能让任务留在 leased 等租约过期。
        const failed = failedPublicNote(task.url, task.platform, `竞对公开页 ${task.platform}`, 'empty_page');
        try {
          await client.results(task, failed);
        } catch (reportError) {
          safeConsoleError('[benchmark-observe] 失败结果提交失败', describeError(reportError));
        }
        safeConsoleError('[benchmark-observe] 采集失败', describeError(error));
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      // 没有未领取任务、旧服务端未公布 benchmark 操作、网络失败都走这里；
      // 不改变平台采集状态栏，也不伪造成功。
      safeConsoleError('[benchmark-observe] 循环异常', describeError(error));
    } finally {
      benchmarkObserveInFlight = false;
    }
  };
  void tick();
  benchmarkObserveTimer = setInterval(() => void tick(), BENCHMARK_OBSERVE_INTERVAL_MS);
  benchmarkObserveTimer.unref?.();
}

export function stopBenchmarkObserveLoop(): void {
  if (!benchmarkObserveTimer) return;
  clearInterval(benchmarkObserveTimer);
  benchmarkObserveTimer = null;
}
