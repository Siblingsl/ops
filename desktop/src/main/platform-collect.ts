// OPT-E04a：main.ts 的平台命令、本机登录、采集、账号 profile 元数据与浏览器探测拆出模块。
// 行为与 IPC 契约逐字节保持；跨域单例由 main.ts 经 PlatformCollectDeps 注入。
import { app } from 'electron';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DesktopClient } from '../desktop-client';
import {
  parseEnvelope,
  PlatformIPCErrorException,
  PlatformIPCSingleFlight,
  toIPCError,
  validatePayloadShape,
  withTimeout,
  type PlatformIPCEnvelope,
  type PlatformIPCError
} from '../platform-ipc';
import {
  findPlatformBrowser,
  PlatformBrowserError,
  probePlatformBrowser
} from '../platform-worker';
import {
  createCDPClient,
  launchPlatformBrowser
} from '../platform-worker';
import {
  createPageResponseSource,
  openLoginPage,
  probeLoginChallenge,
  waitForLogin,
  PLATFORM_LOGIN_POLL_MS,
  PLATFORM_LOGIN_TIMEOUT_MS,
  PLATFORM_LOGIN_URLS,
  type PlatformLoginPlatform,
  type PlatformLoginSession
} from '../platform-login';
import { dismissPlatformLoginHandoff, showPlatformLoginHandoff } from '../platform-login-handoff';
import { appendLoginChallengeEvidence } from '../platform-login-evidence';
import { challengeErrorMessage, type ChallengeOutcome } from '../platforms/challenge-detect';
import { connectionProfileDir, buildProfileMeta, profileMetaPath, removeConnectionNamespace, orphanConnections } from '../platform-profile';
import { maybeCapturePlatformBaseline } from '../platforms/baseline-capture';
import { parseIdentity as parseXhsIdentity, probeCapabilities as probeXhsCapabilities, collectPostedNotes, noteToObservation, normalizeXhsNoteTime, readNoteBody, readCommentFacts, toCommentResult, readFollowerTotal, XHS_API, XhsAdapterError } from '../platforms/xhs';
import { parseIdentity as parseWechatIdentity, probeCapabilities as probeWechatCapabilities, collectPublishedArticles, articleToObservation, normalizeWechatSentAt, WECHAT_MP_API, WechatAdapterError } from '../platforms/wechat-mp';
import { buildPlatformCatalogCompletion, platformV1CoverageStopReason, PlatformClient, type PlatformObservationDraft, type PlatformClaimedRun } from '../platform-client';
import { PlatformLoginFlow, type LoginAction } from '../platform-login-flow';
import { startPlatformLogin, savePlatformLogin } from '../platform-login-runtime';
import { trustedLoginBrowsers, selectLoginBrowser, type LoginBrowserFamily } from '../platform-browser-trust';
import { readAccountProfile, accountProfileSlot } from '../platform-profile';

export interface PlatformCollectDeps {
  getDesktopClient(): DesktopClient | null;
  getPlatformLoginFlow(): PlatformLoginFlow;
  getServiceNamespace(): string;
}

let deps: PlatformCollectDeps | null = null;
// 保持原代码引用形态：serviceNamespace 在启动时由 main.ts 解析后注入本模块。
let serviceNamespace = '';

export function configurePlatformCollect(next: PlatformCollectDeps): void {
  deps = next;
  serviceNamespace = next.getServiceNamespace();
}

function requireDeps(): PlatformCollectDeps {
  if (!deps) throw new Error('平台采集模块尚未初始化。');
  // serviceNamespace 在启动时解析，可能晚于首次 configure；这里按注入 getter 刷新。
  serviceNamespace = deps.getServiceNamespace();
  return deps;
}

// 平台命令的单一执行入口：先校验信封、命令白名单与参数形状，再单飞执行；
// 所有失败都压成稳定错误码与安全文案，不回传路径、堆栈或原始平台响应。
const platformIPC = new PlatformIPCSingleFlight();

// 一次登录会话：一个浏览器、一个 profile，避免双开争用同一目录。
let activeLogin: { accountId: string; platform: PlatformLoginPlatform } | null = null;

// 同意说明版本：内容变更时递增，服务端据此要求重新确认（§4.1 步骤 3）。
const PLATFORM_CONSENT_VERSION = 1;

// 本机登录的 IPC 超时：等待用户扫码最长 3 分钟（与 platform-login 的轮询上限一致），
// 再加 30 秒余量给浏览器启动、身份解析与服务端建连接。
// 不能用 5 秒的通用超时：那会在用户还没扫完码时就把命令判成失败。
const PLATFORM_LOGIN_IPC_TIMEOUT_MS = 220_000;

// 采集命令的 IPC 超时：claim + 心跳 + 页面取数 + 解析 + 提交终批，
// 首次采集还要启动浏览器与导航，给 3 分钟。
const PLATFORM_COLLECT_IPC_TIMEOUT_MS = 180_000;

export async function runPlatformCommand(raw: unknown): Promise<{ ok: true; data?: unknown } | { ok: false; error: PlatformIPCError }> {
  try {
    const envelope = parseEnvelope(raw);
    validatePayloadShape(envelope.cmd, envelope.payload);

    // status/cancel 必须能在 probe/confirm 在途时执行；流程 owner 自行约束写步骤单飞。
    if (envelope.cmd !== 'login-action') platformIPC.begin(envelope.cmd);
    try {
      // 超时按命令区分：`open-login` 要等用户本人扫码（最长 3 分钟），
      // `request-collect` 要读页面、抓响应、提交批次，同样远超 5 秒。
      // 用 5 秒的通用超时会在流程走完前就把命令判死（2026-10-21 实测两次复现）。
      // `read-status`/`pause` 等快命令仍是 5 秒，保持“本机操作不能挂住页面”的约束。
      const data = await withTimeout(
        executePlatformCommand(envelope),
        platformCommandTimeout(envelope.cmd)
      );
      return { ok: true, data };
    } finally {
      if (envelope.cmd !== 'login-action') platformIPC.end(envelope.cmd);
    }
  } catch (error) {
    // 诊断：把真实异常打到主进程日志，便于定位被 toIPCError 压掉的失败原因。
    // 只记录错误码与首行消息，不记录路径、堆栈或平台响应内容。
    console.error('[platform-command]', envelopeCmdOf(raw), describeError(error));
    return { ok: false, error: toIPCError(error) };
  }
}

// platformCommandTimeout 给每条本机命令一个与其真实耗时相称的上限。
// 快命令保持 5 秒（默认值），需要等用户或跑完整流程的命令单独放宽。
function platformCommandTimeout(cmd: string): number | undefined {
  if (cmd === 'open-login') return PLATFORM_LOGIN_IPC_TIMEOUT_MS;
  if (cmd === 'login-action') return 45_000;
  if (cmd === 'login-browsers') return 40_000;
  if (cmd === 'request-collect') return PLATFORM_COLLECT_IPC_TIMEOUT_MS;
  if (cmd === 'request-account-sync' || cmd === 'request-metrics-refresh' || cmd === 'resume-platform-sync') return 30_000;
  return undefined;
}

function envelopeCmdOf(raw: unknown): string {  try {
    const v = raw as { cmd?: unknown } | null;
    return typeof v?.cmd === 'string' ? v.cmd : '(unknown)';
  } catch {
    return '(unknown)';
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === 'string' ? code : error.name}: ${error.message.split('\n')[0].slice(0, 200)}`;
  }
  return String(error).slice(0, 200);
}

async function executePlatformCommand(envelope: PlatformIPCEnvelope): Promise<unknown> {
  const desktopClient = requireDeps().getDesktopClient();
  switch (envelope.cmd) {
    case 'read-status': {
      // 只回报能力摘要、浏览器探测结论与待清理目录数量，不含本机路径或会话内容。
      const capability = await desktopClient?.getPlatformCollectionCapability();
      const browser = await readPlatformBrowserStatus();
      const orphans = await countOrphanProfiles();
      return {
        supported: capability ? capability.enabled : false,
        protocolVersion: capability?.protocol_version ?? null,
        platforms: capability?.platforms ?? [],
        browser,
        orphanProfiles: orphans
      };
    }
    case 'open-login': {
      const payload = envelope.payload as { accountId: string; platform: PlatformLoginPlatform; browserFamily?: LoginBrowserFamily; operationId?: string };
      if (platformIPC.isBusy('request-collect')) throw new PlatformBrowserError('platform_profile_busy', '正在读取平台数据，请稍后连接');
      return requireDeps().getPlatformLoginFlow().open(payload.accountId, payload.platform, payload.browserFamily, payload.operationId);
    }
    case 'login-action': {
      const payload = envelope.payload as { operationId: string; action: LoginAction };
      return requireDeps().getPlatformLoginFlow().action(payload.operationId, payload.action);
    }
    case 'login-browsers': {
      const payload = envelope.payload as { accountId: string; platform: string };
      const auth = await desktopClient!.getAuthContext();
      const stored = await readAccountProfile(app.getPath('userData'), { ...auth, ...payload, origin: serviceNamespace });
      return { fixedFamily: stored.meta?.browserFamily ?? null, candidates: (await trustedLoginBrowsers()).map((candidate) => ({ family: candidate.family, name: candidate.family === 'chrome' ? 'Google Chrome' : 'Microsoft Edge' })) };
    }
    case 'request-collect': {
      const payload = envelope.payload as { accountId: string };
      return runPlatformCollect(payload.accountId);
    }
    case 'request-account-sync': {
      if (!desktopClient) throw new Error('客户端设置尚未初始化。');
      const payload = envelope.payload as { accountId: string; mode: 'incremental' | 'full_reconcile'; connectionRevision: number };
      const requestIdIsUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(envelope.id);
      return desktopClient.requestPlatformAccountSync({ ...payload, idempotencyKey: requestIdIsUuid ? envelope.id : randomUUID() });
    }
    case 'request-metrics-refresh': {
      if (!desktopClient) throw new Error('客户端设置尚未初始化。');
      const payload = envelope.payload as { accountId: string; connectionRevision: number; platformWorkIds?: string[] };
      return desktopClient.requestPlatformMetricsRefresh({ ...payload, idempotencyKey: randomUUID() });
    }
    case 'resume-platform-sync': {
      if (!desktopClient) throw new Error('客户端设置尚未初始化。');
      const payload = envelope.payload as { accountId: string; operationId: string; expectedOperationRevision: number };
      return desktopClient.resumePlatformSyncOperation(payload);
    }
    case 'pause':
      // 暂停由页面直接调 PATCH 连接（只改 auto_collect），本机无副作用，保留稳定错误码。
      return { performed: false, errorCode: 'platform_client_required' };
    case 'clear-account-data': {
      const payload = envelope.payload as { accountId: string };
      return clearPlatformAccountData(payload.accountId);
    }
    case 'clear-orphan-profiles': {
      const payload = envelope.payload as { platform: PlatformLoginPlatform };
      return clearOrphanProfiles(payload.platform);
    }
    default:
      throw new PlatformIPCErrorException('ipc_unknown_command', '不支持的本机命令');
  }
}

// ---------- 本机平台登录（DEV-PS13 / 20 文档 §4.1、§5.1） ----------
//
// 一次登录会话的生命周期：建/复用连接命名空间 profile → 启动本机浏览器 →
// 打开官方后台 → 等用户本人扫码 → 页面内固定只读请求读回身份 → 建连接并验证 → 关浏览器。
// 浏览器与 profile 只在本次会话内存在，会话结束后不保留任何登录凭据到 OPS 侧。

interface PlatformLoginOutcome {
  opened: true;
  connected: boolean;
  externalAccountKey: string | null;
  connectionId: string | null;
  displayName: string | null;
  timedOut: boolean;
  attempts: number;
}

// B-01.6：登录页出现风控时用 Electron 原生窗口提示人工完成，不向登录页注入 DOM。
// 点击只发 handoff_complete 信号；登录成功仍由 waitForLogin 轮询页面身份确认。
function showLoginChallengeHandoff(platform: PlatformLoginPlatform, outcome: ChallengeOutcome): void {
  // 仅当 OPS_PLATFORM_LOGIN_EVIDENCE=1 时落本地 JSONL（URL 去 query）；
  // 写入失败不影响提示与轮询，默认关闭时是空操作。
  void appendLoginChallengeEvidence(app.getPath('userData'), { platform, outcome }).catch(() => undefined);
  const platformLabel = platform === 'xhs' ? '小红书' : platform === 'wechat_mp' ? '公众号' : '头条';
  let origin = '';
  try {
    origin = new URL(PLATFORM_LOGIN_URLS[platform]).origin;
  } catch {
    origin = '';
  }
  void showPlatformLoginHandoff({
    platform: platformLabel,
    vendor: outcome.vendor,
    kind: outcome.kind,
    message: challengeErrorMessage(outcome),
    origin
  });
}

async function openPlatformLogin(accountId: string, platform: PlatformLoginPlatform): Promise<PlatformLoginOutcome> {
  // D-131：旧 PS13 单步实现保留作协作期间历史参考，正式 IPC 仅走 platformLoginFlow。
  // 不再从 UI 调用，避免绕过本人身份确认；按用户要求不删除其他工作中的代码。
  const desktopClient = requireDeps().getDesktopClient();
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin) {
    // 已有会话在跑：明确拒绝，不静默顶掉另一个正在扫码的窗口。
    throw new PlatformBrowserError('platform_profile_busy', '另一个平台登录正在进行，请先完成或关闭它');
  }
  activeLogin = { accountId, platform };
  let session: PlatformLoginSession | null = null;
  try {
    const auth = await desktopClient.getAuthContext();
    const candidate = await findPlatformBrowser();
    // profile 按「登录用户 / 平台 / 连接」隔离；首版一次登录对应一个待验证连接，
    // 连接 ID 在服务端建好后才存在，因此这里先用账号维度的一次性命名空间，
    // 登录成功后由服务端返回的连接 ID 接管后续采集会话（见 D-129 的 PS13 口径）。
    const profileDir = connectionProfileDir(await app.getPath('userData'), {
      userId: auth.userId,
      platform,
      connectionId: auth.connectionNamespaceId
    });
    await fs.mkdir(path.dirname(profileDir), { recursive: true });
    await fs.writeFile(profileMetaPath(profileDir), JSON.stringify(buildProfileMeta({
      origin: serviceNamespace,
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      deviceId: auth.deviceId,
      platform,
      connectionId: auth.connectionNamespaceId,
      externalAccountKey: ''
    }), null, 2), { encoding: 'utf8', mode: 0o600 });

    const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir });
    const cdp = createCDPClient(browser, 20_000);
    session = { platform, profileDir, browser, cdp };
    try {
      // 公众号的账号列表只在页面首次进入后台时由页面自己发起（switchacct），
      // 之后再导航不会重发，构造请求也恒回 not found。因此必须在导航前就注册监听。
      // 新 profile 会先停在扫码页：此时监听仍在，用户扫码进后台后才会捕获到。
      const page = await openLoginPage(session, platform === 'wechat_mp'
        ? { captureBeforeNavigate: [WECHAT_IDENTITY_PATH], captureTimeoutMs: 20_000 }
        : {});
      // 公众号身份优先用导航期间捕获的 switchacct 响应，而不是页面内重新拼请求。
      if (platform === 'wechat_mp') {
        let capturedIdentity = page.captured.get(WECHAT_IDENTITY_PATH);
        // 还没捕获到说明停在扫码页：继续等用户扫码，监听在后台仍有效。
        if (capturedIdentity === undefined) {
          capturedIdentity = await waitForWechatIdentity(session, {
            onChallenge: (outcome) => showLoginChallengeHandoff(platform, outcome)
          });
        }
        if (capturedIdentity !== undefined) {
          return finishWechatLogin(accountId, capturedIdentity);
        }
        // 仍然没有：明确说明原因，不退回“只有 token 没有身份”的半可信状态。
        throw new PlatformBrowserError('platform_identity_mismatch', '没有取到公众号账号身份，请重新登录后再试');
      }
      const outcome = await waitForLogin(session, {
        onChallenge: (challenge) => showLoginChallengeHandoff(platform, challenge)
      });
      if (!outcome.loggedIn || !outcome.payload) {
        return {
          opened: true,
          connected: false,
          externalAccountKey: null,
          connectionId: null,
          displayName: null,
          timedOut: outcome.timedOut,
          attempts: outcome.attempts
        };
      }
      // 身份解析用 PS05/06 已有的适配器，不在这里另写一套字段提取。
      // 两个平台的 identity 形状不同，分开走各自的 probe，不做联合类型收窄。
      const parsed = JSON.parse(outcome.payload);
      const now = new Date().toISOString();
      let externalAccountKey: string;
      let displayName: string | null;
      let capabilities: Record<string, unknown>;
      if (platform === 'xhs') {
        const identity = parseXhsIdentity(parsed);
        externalAccountKey = identity.externalAccountKey;
        displayName = identity.redId || null;
        capabilities = probeXhsCapabilities({
          mainSiteLoggedIn: true,
          identity,
          postedNotesReadable: true,
          followerInfoReadable: true,
          now
        }) as unknown as Record<string, unknown>;
      } else {
        const identity = parseWechatIdentity(parsed);
        externalAccountKey = identity.externalAccountKey;
        displayName = identity.originalID || null;
        capabilities = probeWechatCapabilities({
          backendLoggedIn: true,
          identity,
          listReadable: true,
          now
        }) as unknown as Record<string, unknown>;
      }
      const created = await desktopClient.createPlatformConnection({
        accountId,
        externalAccountKey,
        consentVersion: PLATFORM_CONSENT_VERSION
      });
      const connectionId = typeof created.id === 'string' ? created.id : null;
      if (connectionId) {
        await desktopClient.verifyPlatformConnection({
          connectionId,
          externalAccountKey,
          capabilities
        });
        // 写入"账号 slot"的 meta：采集时要靠它确认"这条 run 属于本机已登录的这个账号"。
        const loginAuth = await desktopClient.getAuthContext();
        await writeAccountProfileMeta({
          auth: loginAuth,
          accountId,
          platform,
          externalAccountKey,
          connectionId: accountProfileSlot({ ...loginAuth, origin: serviceNamespace, accountId, platform })
        });
      }
      return {
        opened: true,
        connected: true,
        externalAccountKey,
        connectionId,
        displayName,
        timedOut: false,
        attempts: outcome.attempts
      };
    } finally {
      await cdp.close();
    }
  } finally {
    dismissPlatformLoginHandoff();
    activeLogin = null;
    session = null;
  }
}

// ---------- 本机平台采集（DEV-PS15 / 20 文档 §4.2、§10） ----------
//
// 一次采集：claim 取一条 run → 按 query_scope 读页面 → 适配器解析成观测 →
// 按批次提交 → 终批报告 run_status。只读，不点发布/删除/修改。
// 采集会话同样用独立 profile，结束后优雅关闭以保住登录会话。

export interface PlatformCollectOutcome {
  performed: boolean;
  runId: string | null;
  runStatus: string;
  accepted: number;
  rejected: number;
  stopReason: string | null;
  errorCode: string | null;
  // auto_adopt 开启时未能投影为正式指标的行数与原因。
  // accepted 仍计入（观测确实入库），但"没进正式指标"必须让用户看见，
  // 否则只会看到一条显示成功的日志。
  adoptErrors: number;
  adoptReason: string | null;
}

export function isPlatformLoginActive(): boolean {
  const platformLoginFlow = requireDeps().getPlatformLoginFlow();
  return Boolean(activeLogin) || platformLoginFlow.active;
}

export async function runPlatformCollect(accountId: string, preClaimedRun?: PlatformClaimedRun): Promise<PlatformCollectOutcome> {
  const desktopClient = requireDeps().getDesktopClient();
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (isPlatformLoginActive()) {
    throw new PlatformBrowserError('platform_profile_busy', '另一个平台登录正在进行，请先完成或关闭它');
  }
  const capability = await desktopClient.getPlatformCollectionCapability();
  const client = new PlatformClient(capability, async (operation, method, path, body) =>
    desktopClient!.platformSignedCall(operation, method, path, body));

  // 后台循环已经领过任务时直接用，避免重复 claim 把刚领到的 run 丢掉。
  let run = preClaimedRun ?? null;
  if (run) {
    // 本实例还没 claim 过，必须显式接管，否则 heartbeat/submit 会报"没有已领取的任务"。
    client.adopt(run);
  } else {
    // 先发一次 presence，让服务端知道本设备在线（调度按 presence 派任务）。
    await client.presence();
    run = await client.claim();
  }
  if (!run) {
    return {
      performed: true, runId: null, runStatus: 'no_task',
      accepted: 0, rejected: 0, stopReason: null, errorCode: null, adoptErrors: 0, adoptReason: null
    };
  }
  if (run.wire_protocol_version === 2) {
    return runPlatformV2Collect(accountId, run, client);
  }
  if (run.platform !== 'xhs' && run.platform !== 'wechat_mp') {
    // 两个平台之外的任务一律拒绝，不猜测平台。
    await client.submit({
      final_batch: true,
      run_status: 'failed',
      stop_reason: 'platform_not_supported',
      error_code: 'platform_not_supported',
      observations: []
    });
    return {
      performed: true, runId: run.id, runStatus: 'failed',
      accepted: 0, rejected: 0, stopReason: 'platform_not_supported', errorCode: 'platform_not_supported', adoptErrors: 0, adoptReason: null
    };
  }
  const platform = run.platform as PlatformLoginPlatform;

  const auth = await desktopClient.getAuthContext();
  // profile 目录必须与**登录写入口**一致。v2 登录流程把平台会话写进账号 slot
  // （accountProfileSlot 派生的哈希目录，见 platform-login-runtime.ts），
  // 采集却读设备命名空间（connectionNamespaceId）时，那个目录里可能还留着
  // 另一个账号的旧登录态，于是整批采集读成了别人的笔记
  // （2026-10-22 实测：验收号只读到 1 篇，正是命名空间里残留账号的作品）。
  const stored = await readAccountProfile(app.getPath('userData'), { ...auth, origin: serviceNamespace, accountId: run.account_id, platform });
  const profileDir = stored.profileDir;
  // 归属校验全部由 readAccountProfile 负责（含历史 profile 缺 accountId 的兼容），
  // 这里只判断"有没有可用的归属信息"：meta 为 null 表示该 slot 从未登录过。
  console.error('[collect] profile-check', JSON.stringify({
    hasMeta: stored.meta !== null,
    metaPlatform: stored.meta?.platform ?? null,
    runPlatform: platform
  }));
  if (!stored.meta) {
    await client.submit({ final_batch: true, run_status: 'failed', stop_reason: 'login_required', error_code: 'platform_login_required', observations: [] });
    return { performed: true, runId: run.id, runStatus: 'failed', accepted: 0, rejected: 0, stopReason: 'login_required', errorCode: 'platform_login_required', adoptErrors: 0, adoptReason: null };
  }
  const candidate = selectLoginBrowser(await trustedLoginBrowsers(), stored.meta.browserFamily);
  const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir });
  const cdp = createCDPClient(browser, 20_000);
  const session = { platform, profileDir, browser, cdp };
  let accepted = 0;
  let rejected = 0;
  try {
    const page = await openLoginPage(session);
    if (!isLoggedInLanding(platform, page.url)) {
      // 会话失效：如实报告需要重新登录，不重试、不反复拉二维码。
      const receipt = await client.submit({
        final_batch: true,
        run_status: 'failed',
        stop_reason: 'login_required',
        error_code: 'platform_login_required',
        observations: []
      });
      return {
        performed: true, runId: run.id, runStatus: receipt.run_status,
        accepted: receipt.accepted, rejected: receipt.rejected,
        stopReason: 'login_required', errorCode: 'platform_login_required',
        adoptErrors: 0, adoptReason: null
      };
    }
    // 心跳：确认租约仍在、未被取消。
    const beat = await client.heartbeat();
    if (beat.canceled) {
      const receipt = await client.submit({
        final_batch: true, run_status: 'canceled', stop_reason: 'canceled', error_code: null, observations: []
      });
      return {
        performed: true, runId: run.id, runStatus: receipt.run_status,
        accepted: receipt.accepted, rejected: receipt.rejected, stopReason: 'canceled', errorCode: null,
        adoptErrors: 0, adoptReason: null
      };
    }

    // 旧版单阶段采集同样要走节奏包装：滚动续读会在一次采集里连发多次列表请求，
    // §13.1 要求串行且相邻请求至少间隔 5 秒。
    const source = pacedPlatformSource(createPageResponseSource(session));
    // 观测必须带真实的外部账号键，否则服务端无法把作品归到正确连接。
    // 优先用 run 冻结的绑定快照，其次回读连接摘要。
    const externalAccountKey = await resolveRunAccountKey(run);
    if (!externalAccountKey) {
      throw new PlatformBrowserError('platform_identity_mismatch', '本次任务缺少外部账号标识');
    }
    // 目录改对之后仍要核对“这份登录态就是本任务的账号”：采到别人的笔记比采不到更糟（§6.2）。
    // 读不到身份时只跳过核对并留痕，不因此把整次采集判失败。
    if (platform === 'xhs') {
      try {
        const current = parseXhsIdentity(await source.fetchJSON(XHS_API.userInfo));
        if (current.externalAccountKey !== externalAccountKey) {
          throw new PlatformBrowserError('platform_identity_mismatch', '浏览器登录的账号与本次任务不一致');
        }
      } catch (identityError) {
        if (identityError instanceof PlatformBrowserError && identityError.code === 'platform_identity_mismatch') throw identityError;
        console.error('[collect] identity-check skipped', describeError(identityError));
      }
    }
    // B-05：每个 profile 每天第一次采集前跑一次截图基线巡检；只记 schema_suspect，
    // 不自行暂停采集。巡检失败不影响本次采集。
    await maybeCapturePlatformBaseline(session).catch((baselineError) => {
      console.warn('[collect] baseline check skipped', describeError(baselineError));
    });
    const observedAt = new Date().toISOString();
    // 服务端按 run 冻结的 binding_snapshot 逐篇比对作品、绑定修订与发布修订；
    // 客户端必须原样回传这两个 revision，否则会被判“绑定或发布信息已变化”。
    const targets = parseRunTargets(run.binding_snapshot);
    const drafts: PlatformObservationDraft[] = [];
    let rowNo = 0;
    let unmatched = 0;
    let discovered = 0;
    let coverage: Record<string, unknown>;
    if (platform === 'xhs') {
      // 笔记列表接口需要平台签名，直接 GET 会被回 406（2026-10-21 实测）。
      // 适配器通过 source.fetchSigned 走“页面自发请求 + 响应监听”，不构造也不复制签名。
      const discovery = await collectPostedNotes(source, { maxPages: 3 });
      discovered = discovery.notes.length;
      coverage = discovery.coverage;
      for (const note of discovery.notes) {
        const target = targets.get(note.noteId);
        // 不提交快照之外的作品：§7.2 不允许把未绑定作品塞进采集结果。
        if (!target) {
          unmatched += 1;
          continue;
        }
        const draft = noteToObservation(note, {
          externalAccountKey,
          observedAt,
          bindingRevision: target.bindingRevision,
          publishRevision: target.publishRevision
        });
        if (!draft) continue;
        drafts.push({ ...draft, row_no: rowNo });
        rowNo += 1;
      }
    } else {
      // 公众号发表记录：接口需要页面 URL 里的 token（适配器经响应源自动补），
      // `publish_page` 是嵌套 JSON 字符串，适配器已二次解析。
      const discovery = await collectPublishedArticles(source, { maxPages: 3 });
      discovered = discovery.articles.length;
      coverage = discovery.coverage as unknown as Record<string, unknown>;
      for (const article of discovery.articles) {
        const target = targets.get(article.externalID.toLowerCase());
        if (!target) {
          unmatched += 1;
          continue;
        }
        const draft = articleToObservation(article, {
          externalAccountKey,
          observedAt,
          bindingRevision: target.bindingRevision,
          publishRevision: target.publishRevision
        });
        if (!draft) continue;
        drafts.push({ ...draft, row_no: rowNo });
        rowNo += 1;
      }
    }
    console.error('[collect] discovery', JSON.stringify({
      platform,
      discovered,
      targets: targets.size,
      unmatched,
      drafts: drafts.length,
      coverage
    }));
    const incomplete = typeof coverage.incomplete_reason === 'string' ? coverage.incomplete_reason : null;
    const stopReason = platformV1CoverageStopReason(incomplete);
    const receipt = await client.submit({
      final_batch: true,
      run_status: incomplete ? 'partial' : 'succeeded',
      stop_reason: stopReason,
      error_code: null,
      coverage,
      observations: drafts
    });
    accepted = receipt.accepted;
    rejected = receipt.rejected;
    return {
      performed: true, runId: run.id, runStatus: receipt.run_status,
      accepted, rejected, stopReason: incomplete, errorCode: null,
      // auto_adopt 开启时，服务端会把未能投影的行数放回执。
      // 这些行"观测已入库但没进正式指标"，必须透出来，不能让用户以为全部生效。
      adoptErrors: receipt.adopt_errors ?? 0,
      adoptReason: receipt.adopt_reason ?? null
    };
  } catch (error) {
    const code = platformCollectErrorCode(error);
    // 失败也要交终批，否则 run 会一直挂在 leased 直到租约过期。
    console.error('[collect] failed', code, describeError(error));
    await client.submit({
      final_batch: true, run_status: 'failed', stop_reason: 'collect_failed', error_code: code, observations: []
    }).catch((submitError) => {
      console.error('[collect] final batch rejected', describeError(submitError));
    });
    return {
      performed: true, runId: run.id, runStatus: 'failed',
      accepted: 0, rejected: 0, stopReason: 'collect_failed', errorCode: code, adoptErrors: 0, adoptReason: null
    };
  } finally {
    await cdp.close();
  }
}
const PLATFORM_V2_PAGE_LIMIT = 3;
const PLATFORM_V2_PAGE_SIZE = 20;
const PLATFORM_V2_PACING_MS = 5_000;

function pacedPlatformSource(source: ReturnType<typeof createPageResponseSource>): ReturnType<typeof createPageResponseSource> {
  let lastRequestAt = 0;
  const paced = async <T,>(read: () => Promise<T>): Promise<T> => {
    const wait = PLATFORM_V2_PACING_MS - (Date.now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await read();
    lastRequestAt = Date.now();
    return result;
  };
  return {
    ...source,
    fetchJSON: (path) => paced(() => source.fetchJSON(path)),
    fetchSigned: (path) => paced(() => source.fetchSigned(path)),
    // 滚动续读同样要串行 + 相邻请求至少 5 秒（docs/21 §安全修复：串行并至少间隔 5 秒）。
    fetchSignedNextPage: (path) => paced(() => source.fetchSignedNextPage(path)),
    observeResponse: (path, trigger, timeout) => paced(() => source.observeResponse(path, trigger, timeout)),
    // 单篇详情与评论读取也共享同一节奏窗口：详情页导航/评论接口之间保持 ≥5 秒。
    fetchNoteDetail: source.fetchNoteDetail
      ? (noteId) => paced(() => source.fetchNoteDetail!(noteId))
      : undefined,
    fetchComments: source.fetchComments
      ? (noteId) => paced(() => source.fetchComments!(noteId))
      : undefined
  };
}

// pacedPlatformSourceDetail 已由 pacedPlatformSource 内统一包装；
// 不再单独提供未节流的详情闭包，避免“看起来节流、实际直发”。

interface PlatformV2TargetSnapshot {
  externalID: string;
  bindingRevision?: number;
  publishRevision?: number;
  // content 阶段冻结目标携带的镜像内容修订（服务端 pendingPlatformMirrorTargets 下发）；
  // 上报 work_content 时必须原样回传，否则被判“内容修订与冻结目标不一致”。
  contentRevision?: number;
  // 冻结目标的远端内容类型（image_note / video_note / wechat_article 等），供正文行复用。
  remoteContentType?: string;
}

export function parsePlatformV2Targets(snapshot: unknown): { local: Map<string, PlatformV2TargetSnapshot>; mirrors: Map<string, PlatformV2TargetSnapshot> } {
  const local = new Map<string, PlatformV2TargetSnapshot>();
  const mirrors = new Map<string, PlatformV2TargetSnapshot>();
  if (!snapshot || typeof snapshot !== 'object') return { local, mirrors };
  const value = snapshot as { local_bindings?: unknown; platform_works?: unknown };
  if (Array.isArray(value.local_bindings)) for (const item of value.local_bindings) {
    if (!item || typeof item !== 'object') continue;
    const target = item as { external_id?: unknown; binding_revision?: unknown; publish_revision?: unknown };
    if (typeof target.external_id !== 'string' || typeof target.binding_revision !== 'number' || typeof target.publish_revision !== 'number') continue;
    local.set(target.external_id, { externalID: target.external_id, bindingRevision: target.binding_revision, publishRevision: target.publish_revision });
  }
  if (Array.isArray(value.platform_works)) for (const item of value.platform_works) {
    if (!item || typeof item !== 'object') continue;
    const target = item as { external_id?: unknown; content_revision?: unknown; remote_content_type?: unknown };
    if (typeof target.external_id !== 'string') continue;
    mirrors.set(target.external_id, {
      externalID: target.external_id,
      ...(typeof target.content_revision === 'number' ? { contentRevision: target.content_revision } : {}),
      ...(typeof target.remote_content_type === 'string' ? { remoteContentType: target.remote_content_type } : {})
    });
  }
  return { local, mirrors };
}

export function platformV2StartPage(queryScope: unknown): number {
  if (!queryScope || typeof queryScope !== 'object') return 0;
  const checkpoint = (queryScope as { checkpoint?: unknown }).checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return 0;
  const page = (checkpoint as { next_page?: unknown }).next_page;
  return typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page : 0;
}

export function platformV2ScopeUpperBound(queryScope: unknown): number | null {
  if (!queryScope || typeof queryScope !== 'object') return null;
  const frozen = (queryScope as { frozen_scope?: unknown }).frozen_scope;
  if (!frozen || typeof frozen !== 'object') return null;
  const raw = (frozen as { scope_upper_bound?: unknown }).scope_upper_bound;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function platformV2CatalogItem(input: {
  externalID: string; accountKey: string; contentType: string; title: string; authorDisplay: string;
  publishedAt: string | null; metrics: PlatformObservationDraft | null; upperBound: number | null;
}): { item: Record<string, unknown> | null; outsideUpperBound: boolean; missingPublishedAt: boolean } {
  const publishedTime = input.publishedAt ? Date.parse(input.publishedAt) : Number.NaN;
  const outsideUpperBound = input.upperBound !== null && Number.isFinite(publishedTime) && publishedTime > input.upperBound;
  if (outsideUpperBound) return { item: null, outsideUpperBound, missingPublishedAt: false };
  const fieldStates: Record<string, string> = {
    title: input.title ? 'present' : 'unknown',
    summary: 'unknown', canonical_url: 'unknown', published_at: input.publishedAt ? 'present' : 'unknown',
    remote_updated_at: 'unknown', cover_ref: 'unknown', topics: 'unknown', tags: 'unknown'
  };
  return {
    outsideUpperBound,
    missingPublishedAt: !input.publishedAt,
    item: {
      external_id: input.externalID,
      author_external_account_key: input.accountKey,
      remote_content_type: input.contentType,
      remote_status: 'published',
      title: input.title,
      summary: '',
      author_display: input.authorDisplay,
      topics: [],
      tags: [],
      field_states: fieldStates,
      ...(input.publishedAt ? { published_at: input.publishedAt } : {}),
      ...(input.metrics ? { inline_metrics: [input.metrics] } : {})
    }
  };
}

// CF-PS-07：把一篇笔记的正文事实构造成服务端 work_content 批次的行体。
// 映射约定（与 writePlatformContentItemTx 的行级校验一一对应）：
//   - 读到非空正文：state='complete'，title/body_text 都声明 present；
//   - permission_denied / body 缺失：state='denied'/'unsupported'，正文字段不声明 present；
//   - read_failed / parse_failed / empty_body / body_absent：state='failed'，正文不冒充完整。
// body_structure 恒为空数组：小红书详情响应里没有已实测的块结构契约，正文先以
// 纯文本上送；媒体/话题/标签没有已实测字段，field_states 一律 unknown，不猜。
export function platformV2ContentItem(input: {
  externalID: string; accountKey: string; contentRevision: number | null;
  contentType: string; note: { title: string; body: { present: boolean; text: string | null; reason: string | null } };
  observedAt: string;
}): Record<string, unknown> | null {
  const body = input.note.body;
  const state = body.present && body.text !== null && body.text.trim() !== '' ? 'complete'
    : body.reason === 'permission_denied' ? 'denied'
      : body.reason === 'body_absent' || body.reason === 'empty_body' ? 'unsupported'
        : 'failed';
  const title = input.note.title.trim();
  const fieldStates: Record<string, string> = {
    title: title !== '' ? 'present' : 'unknown',
    body_text: 'unknown', body_structure: 'unknown', summary: 'unknown',
    author_display: 'unknown', topics: 'unknown', tags: 'unknown',
    cover_ref: 'unknown', media_refs: 'unknown', remote_updated_at: 'unknown'
  };
  const item: Record<string, unknown> = {
    external_id: input.externalID,
    author_external_account_key: input.accountKey,
    // 冻结目标没给修订号时按 0 上报：服务端会比对冻结值，不一致就拒绝该行，
    // 客户端不自己猜一个可能过期的修订。
    content_revision: input.contentRevision ?? 0,
    state,
    topics: [],
    tags: [],
    media_refs: [],
    field_states: fieldStates,
    observed_at: input.observedAt
  };
  if (state === 'complete') {
    // complete 必须同时带 title 与 body_text 且声明 present（服务端行级校验）。
    if (title === '' || body.text === null) return null;
    item.title = title;
    item.body_text = body.text;
    fieldStates.title = 'present';
    fieldStates.body_text = 'present';
  } else if (title !== '') {
    // 非完整状态也带上读到的标题，供镜像字段覆盖参考。
    item.title = title;
    fieldStates.title = 'present';
  }
  return item;
}

// REF41 F4：把采集阶段的结构化解析失败上报到 parser-events。只带字段名、错误码、
// 页面指纹与计数；不传 Cookie、账号、原始行内容。上报失败不阻断采集，但会留日志。
async function reportParserInvalidRows(
  client: PlatformClient,
  platform: string,
  adapterVersion: string,
  pageURL: string,
  stage: string,
  field: string,
  invalidRows: number,
  incompleteReason: string | null
): Promise<void> {
  if (invalidRows <= 0) return;
  const pageHash = createHash('sha256')
    .update(`${platform}|${stage}|${field}|${incompleteReason ?? ''}`)
    .digest('hex')
    .slice(0, 64);
  try {
    await client.submitParserEvents([{
      platform,
      adapter_version: adapterVersion,
      page_url: pageURL,
      page_hash: pageHash,
      field,
      error_code: 'parse_failed',
      detail: { invalid_rows: invalidRows, incomplete_reason: incompleteReason, stage }
    }]);
  } catch (error) {
    console.warn('[collect-v2] parser events unavailable', describeError(error));
  }
}

export async function runPlatformV2Collect(accountId: string, run: PlatformClaimedRun, client: PlatformClient): Promise<PlatformCollectOutcome> {
  const desktopClient = requireDeps().getDesktopClient();
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (run.platform !== 'xhs' && run.platform !== 'wechat_mp') {
    return submitV2ControlFailure(client, run, 'platform_browser_unsupported', 'platform_browser_unsupported');
  }
  if (isPlatformLoginActive()) {
    return submitV2ControlFailure(client, run, 'platform_profile_busy', 'platform_profile_busy');
  }
  const platform = run.platform as PlatformLoginPlatform;
  let accepted = 0;
  let rejected = 0;
  let cdp: ReturnType<typeof createCDPClient> | null = null;
  // try 必须覆盖到浏览器启动之前：否则「profile 目录读不到」「浏览器起不来」
  // 这类错误会让函数在没有任何终批的情况下抛出，run 只能等 60 秒租约过期，
  // 再被 expirePlatformRuns 判成 expired——服务端永远收不到失败原因。
  // 2026-10-26 实测：三条 account_sync run 全部 expired、counters={}，
  // 就是因为异常抛在了原来的 try 之外。
  try {
    const auth = await desktopClient.getAuthContext();
    // 与 v1 采集同理：登录态落在账号 slot 里，采集必须读同一个目录，
    // 不能用设备命名空间（那里可能是另一个账号的历史登录态）。
    const stored = await readAccountProfile(app.getPath('userData'), {
      ...auth, origin: serviceNamespace, accountId, platform
    });
    const profileDir = stored.profileDir;
    if (!stored.meta || stored.meta.platform !== platform) {
      return submitV2ControlFailure(client, run, 'platform_login_required', 'platform_login_required');
    }
    const candidate = selectLoginBrowser(await trustedLoginBrowsers(), stored.meta.browserFamily);
    const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir });
    const cdpClient = createCDPClient(browser, 20_000);
    cdp = cdpClient;
    const session = { platform, profileDir, browser, cdp: cdpClient };
    const opened = await client.withHeartbeat(() => openLoginPage(session));
    if (opened.canceled) return { performed: true, runId: run.id, runStatus: 'canceled', accepted: 0, rejected: 0, stopReason: 'canceled', errorCode: null, adoptErrors: 0, adoptReason: null };
    const page = opened.value;
    if (!page) throw new PlatformBrowserError('platform_navigation_failed', '平台页面未能打开');
    if (!isLoggedInLanding(platform, page.url)) return submitV2ControlFailure(client, run, 'platform_login_required', 'platform_login_required');

    const source = pacedPlatformSource(createPageResponseSource(session));
    const externalAccountKey = await resolveRunAccountKey(run);
    if (!externalAccountKey) return submitV2ControlFailure(client, run, 'platform_identity_mismatch', 'platform_identity_mismatch');
    let currentExternalKey = '';
    let displayName = '';
    if (platform === 'xhs') {
      const identity = parseXhsIdentity(await source.fetchJSON(XHS_API.userInfo));
      currentExternalKey = identity.externalAccountKey;
      displayName = identity.redId;
    } else {
      const identityPayload = await source.fetchSigned(WECHAT_MP_API.switchAccount);
      const current = await cdp.request('Runtime.evaluate', {
        expression: `(() => { const id = globalThis.wx?.data?.user_name; return typeof id === 'string' && /^gh_[0-9a-zA-Z]+$/.test(id) ? id : null; })()`,
        returnByValue: true
      }) as { result?: { value?: unknown } };
      const identity = parseWechatIdentity(identityPayload, typeof current.result?.value === 'string' ? current.result.value : undefined);
      currentExternalKey = identity.externalAccountKey;
      displayName = identity.originalID;
    }
    if (currentExternalKey !== externalAccountKey || stored.meta.externalAccountKey && stored.meta.externalAccountKey !== currentExternalKey) {
      return submitV2ControlFailure(client, run, 'platform_identity_mismatch', 'platform_identity_mismatch');
    }

    // B-05：同一 profile 每天首次采集前跑一次基线巡检（只提示，不暂停）。
    await maybeCapturePlatformBaseline(session).catch((baselineError) => {
      console.warn('[collect-v2] baseline check skipped', describeError(baselineError));
    });

    const observedAt = new Date().toISOString();
    const stage = run.operation_stage ?? 'metrics';
    const targets = parsePlatformV2Targets(run.binding_snapshot);
    const expectedMetrics = new Set([...targets.local.keys(), ...targets.mirrors.keys()]);
    if (run.task_kind === 'account_sync' && stage === 'profile') {
      return submitV2Control(client, run, {
        state: 'unknown', reason: 'profile_capability_unverified', observed_at: observedAt
      }, 'partial');
    }
    if (run.task_kind === 'account_sync' && stage === 'catalog') {
      const startPage = platformV2StartPage(run.query_scope);
      const upperBound = platformV2ScopeUpperBound(run.query_scope);
      const items: Array<Record<string, unknown>> = [];
      let uncertainBoundary = false;
      let enumerationComplete = false;
      let totalCount: number | null = null;
      let pagesRead = 0;
      let hasMore = false;
      let incompleteReason: string | null = null;
      const partition = platform === 'xhs' ? 'notes' : 'articles';
      if (platform === 'xhs') {
        const discovered = await collectPostedNotes(source, {
          maxPages: PLATFORM_V2_PAGE_LIMIT,
          startPage,
          buildPath: ({ page: pageNo }) => `${XHS_API.postedNotes}?page=${pageNo}&page_size=${PLATFORM_V2_PAGE_SIZE}`
        });
        enumerationComplete = discovered.enumerationComplete;
        totalCount = discovered.totalCount;
        pagesRead = discovered.pagesRead;
        hasMore = discovered.hasMore;
        incompleteReason = discovered.coverage.incomplete_reason;
        await reportParserInvalidRows(client, platform, run.adapter_version, page.url, 'catalog', partition, discovered.invalidRows, incompleteReason);
        for (const note of discovered.notes) {
          if (note.status !== 'published') continue;
          const publishedAt = normalizeXhsNoteTime(note.recordedAt);
          const frozen = targets.local.get(note.noteId);
          const metrics = noteToObservation(note, { externalAccountKey, observedAt,
            bindingRevision: frozen?.bindingRevision, publishRevision: frozen?.publishRevision });
          const contentType = note.contentType === 'image' ? 'image_note' : note.contentType === 'video' ? 'video_note' : 'unknown';
          const result = platformV2CatalogItem({ externalID: note.noteId, accountKey: externalAccountKey, contentType,
            title: note.title, authorDisplay: displayName || externalAccountKey, publishedAt, metrics, upperBound });
          uncertainBoundary ||= result.missingPublishedAt;
          if (result.item) items.push(result.item);
        }
      } else {
        const discovered = await collectPublishedArticles(source, { maxPages: PLATFORM_V2_PAGE_LIMIT, startPage });
        enumerationComplete = discovered.enumerationComplete;
        totalCount = discovered.coverage.total_count ?? null;
        pagesRead = discovered.pagesRead;
        hasMore = discovered.hasMore;
        incompleteReason = discovered.coverage.incomplete_reason;
        await reportParserInvalidRows(client, platform, run.adapter_version, page.url, 'catalog', partition, discovered.invalidRows, incompleteReason);
        for (const article of discovered.articles) {
          if (article.status !== 'published') continue;
          const publishedAt = normalizeWechatSentAt(article.sentAt);
          const frozen = targets.local.get(article.externalID);
          const metrics = articleToObservation(article, { externalAccountKey, observedAt,
            bindingRevision: frozen?.bindingRevision, publishRevision: frozen?.publishRevision });
          const result = platformV2CatalogItem({ externalID: article.externalID, accountKey: externalAccountKey, contentType: 'wechat_article',
            title: article.title, authorDisplay: displayName || externalAccountKey, publishedAt, metrics, upperBound });
          uncertainBoundary ||= result.missingPublishedAt;
          if (result.item) items.push(result.item);
        }
      }
      for (let offset = 0; offset < items.length; offset += 25) {
        const data: Record<string, unknown> = {
          items: items.slice(offset, offset + 25), enumeration_complete: false,
          partition: platform === 'xhs' ? 'notes' : 'articles', consistency: 'best_effort'
        };
        if (totalCount !== null) data.total_count = totalCount;
        const receipt = await client.submitV2('work_catalog', data);
        accepted += receipt.accepted;
        rejected += receipt.rejected;
      }
      const nextPage = startPage + pagesRead;
      const completion = buildPlatformCatalogCompletion({ enumerationComplete, uncertainBoundary, incompleteReason,
        hasMore, nextPage, partition, totalCount, observedAt });
      const receipt = await client.submitV2('control', completion.data, completion.outcome);
      accepted += receipt.accepted;
      rejected += receipt.rejected;
      return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted, rejected,
        stopReason: completion.outcome.stopReason, errorCode: null, adoptErrors: 0, adoptReason: null };
    }
    if (run.task_kind === 'account_sync' && stage === 'content') {
      // CF-PS-07：正文阶段按冻结的 platform_works 目标逐篇读详情。
      // 服务端只把 content 阶段调度给 noteContent/articleContent=supported 的连接，
      // 但详情源仍可能缺失（宿主登记表为空）——那样逐篇 detail_source_missing，
      // 行以 failed 上报，终批如实 partial，绝不冒充 complete。
      const contentTargets = [...targets.mirrors.values()];
      if (contentTargets.length === 0) {
        return submitV2Control(client, run, { state: 'complete', observed_at: observedAt }, 'succeeded');
      }
      // 正文事实层目前只有 xhs 适配器实现；公众号的详情源（articleContent）尚未落地。
      if (platform !== 'xhs') {
        return submitV2Control(client, run, {
          state: 'unsupported', reason: 'content_capability_unverified', observed_at: observedAt
        }, 'succeeded');
      }
      const sourceWithDetail: typeof source = source;
      let failedRows = 0;
      let commentSourceMissing = false;
      for (let offset = 0; offset < contentTargets.length; offset += 10) {
        const slice = contentTargets.slice(offset, offset + 10);
        const items: Array<Record<string, unknown>> = [];
        for (const target of slice) {
          // 逐篇读正文；单篇失败只影响那一行，不中断整批（D-117 的逐条边界）。
          let body: Awaited<ReturnType<typeof readNoteBody>>;
          try {
            body = await readNoteBody(sourceWithDetail, target.externalID);
          } catch (error) {
            console.error('[collect-v2] note detail failed', target.externalID, describeError(error));
            body = { noteId: target.externalID, title: null, present: false, text: null, reason: 'read_failed' };
          }
          // CF-P2-CXEF-06：评论授权读取。宿主评论源未登记契约时如实 comment_source_missing
          // 并整 run 跳过（不逐篇重复探测）；读到事实时逐条上报（每条一次 HTTP，单条幂等），
          // 失败只记日志不中断正文采集。不提供批量入库。
          if (!commentSourceMissing && platform === 'xhs') {
            const comments = await readCommentFacts(sourceWithDetail, target.externalID);
            if (comments.reason === 'comment_source_missing') {
              commentSourceMissing = true;
            } else if (comments.facts.length > 0) {
              for (let index = 0; index < comments.facts.length; index += 1) {
                const result = toCommentResult('xhs', externalAccountKey, comments.facts, index);
                if (!result) continue; // 不可读事实（reason!=null）跳过，不冒充可读
                try {
                  await client.submitComment(result);
                } catch (error) {
                  console.error('[collect-v2] comment ingest failed', target.externalID, index, describeError(error));
                  break; // 上报通道不可用（旧服务端/网络）：停止本篇剩余上报，不重试
                }
              }
            }
          }
          const item = platformV2ContentItem({
            externalID: target.externalID, accountKey: externalAccountKey,
            contentRevision: target.contentRevision ?? null,
            contentType: target.remoteContentType ?? 'unknown',
            note: { title: body.title ?? '', body: { present: body.present, text: body.text, reason: body.reason } },
            observedAt
          });
          if (item) {
            if (item.state === 'failed') failedRows += 1;
            items.push(item);
          } else {
            failedRows += 1;
          }
        }
        if (items.length === 0) continue;
        const receipt = await client.submitV2('work_content', { items });
        accepted += receipt.accepted;
        rejected += receipt.rejected;
      }
      // 有目标读到 complete 才算本阶段收口；全部失败时如实 partial，
      // 让调度下轮重试，而不是报 complete 把覆盖锁死。
      const contentState = failedRows === 0 && accepted > 0 ? 'complete' : 'partial';
      const reason = contentState === 'complete' ? null : (accepted === 0 ? 'temporarily_unavailable' : 'network_unavailable');
      const receipt = await client.submitV2('control',
        { ...(reason ? { state: contentState, reason, observed_at: observedAt } : { state: contentState, observed_at: observedAt }) },
        { status: contentState === 'complete' ? 'succeeded' : 'partial', stopReason: reason });
      return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted, rejected,
        stopReason: reason, errorCode: null, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
    }

    if ((run.task_kind === 'account_sync' && stage === 'metrics') || run.task_kind === 'collect' && stage === 'metrics') {
      // I6：metrics 阶段同时上报账号级粉丝总数。读不到就保持 null，不伪造 0；
      // 只有 expectedMetrics 为空且粉丝也没读到时才提前收口。
      let follower: { date: string; cumulate: number; collected_at: string } | null = null;
      if (platform === 'xhs') {
        try {
          const total = await readFollowerTotal(source);
          if (total !== null) {
            follower = { date: shanghaiDay(new Date(observedAt)), cumulate: total, collected_at: observedAt };
          }
        } catch (error) {
          console.warn('[collect-v2] follower total unavailable', describeError(error));
        }
      }
      if (expectedMetrics.size === 0 && follower === null) {
        const receipt = await client.submitV2('control', { state: 'complete', observed_at: observedAt }, { status: 'succeeded' });
        return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted: 0, rejected: 0, stopReason: null, errorCode: null, adoptErrors: 0, adoptReason: null };
      }
      const drafts: PlatformObservationDraft[] = [];
      const found = new Set<string>();
      if (platform === 'xhs') {
        const discovered = await collectPostedNotes(source, { maxPages: PLATFORM_V2_PAGE_LIMIT, buildPath: ({ page: pageNo }) => `${XHS_API.postedNotes}?page=${pageNo}&page_size=${PLATFORM_V2_PAGE_SIZE}` });
        await reportParserInvalidRows(client, platform, run.adapter_version, page.url, 'metrics', 'notes', discovered.invalidRows, discovered.coverage.incomplete_reason);
        for (const note of discovered.notes) {
          if (!expectedMetrics.has(note.noteId) || note.status !== 'published') continue;
          found.add(note.noteId);
          const target = targets.local.get(note.noteId);
          const draft = noteToObservation(note, { externalAccountKey, observedAt, bindingRevision: target?.bindingRevision, publishRevision: target?.publishRevision });
          if (draft) drafts.push({ ...draft, row_no: drafts.length });
        }
      } else {
        const discovered = await collectPublishedArticles(source, { maxPages: PLATFORM_V2_PAGE_LIMIT });
        await reportParserInvalidRows(client, platform, run.adapter_version, page.url, 'metrics', 'articles', discovered.invalidRows, discovered.coverage.incomplete_reason);
        for (const article of discovered.articles) {
          if (!expectedMetrics.has(article.externalID) || article.status !== 'published') continue;
          found.add(article.externalID);
          const target = targets.local.get(article.externalID);
          const draft = articleToObservation(article, { externalAccountKey, observedAt, bindingRevision: target?.bindingRevision, publishRevision: target?.publishRevision });
          if (draft) drafts.push({ ...draft, row_no: drafts.length });
        }
      }
      let followerSubmitted = false;
      for (let offset = 0; offset < drafts.length; offset += 25) {
        const payload = {
          observations: drafts.slice(offset, offset + 25),
          ...(follower !== null && !followerSubmitted ? { followers: [follower] } : {})
        };
        const receipt = await client.submitV2('metrics', payload);
        accepted += receipt.accepted;
        rejected += receipt.rejected;
        if (follower !== null && !followerSubmitted) followerSubmitted = true;
      }
      if (follower !== null && !followerSubmitted) {
        const receipt = await client.submitV2('metrics', { observations: [], followers: [follower] });
        accepted += receipt.accepted;
        rejected += receipt.rejected;
        followerSubmitted = true;
      }
      if (found.size < expectedMetrics.size) {
        await client.submitV2('control', {
          state: 'partial', reason: 'target_not_in_bounded_window', observed_at: observedAt
        }, { status: 'partial', stopReason: 'target_not_in_bounded_window' });
        return { performed: true, runId: run.id, runStatus: 'partial', accepted, rejected, stopReason: 'target_not_in_bounded_window', errorCode: null, adoptErrors: 0, adoptReason: null };
      }
      if (drafts.length === 0 && follower === null) {
        await client.submitV2('control', { state: 'partial', reason: 'temporarily_unavailable', observed_at: observedAt }, { status: 'partial', stopReason: 'temporarily_unavailable' });
        return { performed: true, runId: run.id, runStatus: 'partial', accepted, rejected, stopReason: 'temporarily_unavailable', errorCode: null, adoptErrors: 0, adoptReason: null };
      }
      const receipt = await client.submitV2('control', { state: 'complete', observed_at: observedAt }, { status: 'succeeded' });
      accepted += receipt.accepted;
      return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted, rejected, stopReason: null, errorCode: null, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
    }
    return submitV2Control(client, run, { state: 'unknown', reason: 'temporarily_unavailable', observed_at: observedAt }, 'failed');
  } catch (error) {
    const code = platformCollectErrorCode(error);
    console.error('[collect-v2] failed', code, describeError(error));
    return submitV2ControlFailure(client, run, code, code);
  } finally {
    if (cdp) await cdp.close();
  }
}

// 粉丝日值与服务端账号时区口径一致，按 Asia/Shanghai 切日；不依赖本机区域设置。
function shanghaiDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function platformCollectErrorCode(error: unknown): string {
  if (error instanceof PlatformBrowserError || error instanceof XhsAdapterError || error instanceof WechatAdapterError) {
    return error.code;
  }
  return 'platform_network_unavailable';
}

// 服务端只接受 20 文档 §12 固定目录里的 error_code，整批遇到目录外的码会直接 422，
// run 于是卡到租约过期、用户看不到任何原因。这里把本机内部码收敛到目录里的等价码，
// 保证失败原因总能落库；真正的内部码仍留在客户端日志里。
export function platformReportableErrorCode(code: string): string {
  switch (code) {
    case 'platform_navigation_failed':
    case 'platform_timeout':
      return 'platform_network_unavailable';
    case 'platform_browser_mismatch':
      return 'platform_browser_unsupported';
    case 'platform_profile_quota':
      return 'platform_storage_quota_exceeded';
    case 'platform_account_unavailable':
    case 'platform_login_cancelled':
    case 'platform_login_context_changed':
      return 'platform_login_required';
    case 'platform_cleanup_pending':
      return 'platform_profile_busy';
    case 'platform_connection_conflict':
      return 'platform_result_conflict';
    case 'platform_connection_unconfirmed':
      return 'platform_authorization_changed';
    case 'platform_risk_paused':
      return 'platform_account_restricted';
    default:
      return code;
  }
}

function v2ControlReason(errorCode: string): string {
  if (errorCode === 'platform_identity_mismatch') return 'author_identity_unverified';
  if (errorCode === 'platform_login_required' || errorCode === 'platform_challenge_required') return 'access_denied';
  if (errorCode === 'platform_schema_changed') return 'catalog_inconsistent';
  if (errorCode === 'platform_rate_limited' || errorCode === 'platform_account_restricted') return 'platform_risk';
  return 'network_unavailable';
}

async function submitV2Control(client: PlatformClient, run: PlatformClaimedRun, data: Record<string, unknown>, status: 'succeeded' | 'partial' | 'failed' = 'succeeded'): Promise<PlatformCollectOutcome> {
  const receipt = await client.submitV2('control', data, { status, stopReason: typeof data.reason === 'string' ? data.reason : null });
  return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted: receipt.accepted, rejected: receipt.rejected,
    stopReason: typeof data.reason === 'string' ? data.reason : null, errorCode: null, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
}

async function submitV2ControlFailure(client: PlatformClient, run: PlatformClaimedRun, errorCode: string, reasonCode: string): Promise<PlatformCollectOutcome> {
  const reportable = platformReportableErrorCode(errorCode);
  const data = { state: 'unknown', reason: v2ControlReason(reasonCode), observed_at: new Date().toISOString() };
  const receipt = await client.submitV2('control', data, { status: 'failed', stopReason: data.reason, errorCode: reportable });
  return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted: receipt.accepted, rejected: receipt.rejected,
    stopReason: data.reason, errorCode: reportable, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
}

// ---------- 撤销连接与本机清理（DEV-PS23 / 20 文档 §5.4） ----------
//
// 顺序不能反：先调服务端回收（只减权），成功后才删本机 profile。
// 反过来的话，服务端连接还在、本机凭据没了，用户会看到一个再也验证不了的连接。
// 清理只删该连接自己的目录，不递归删账号命名空间（避免误删同账号其它连接）。

interface PlatformClearOutcome {
  performed: boolean;
  revoked: boolean;
  removed: boolean;
  connectionId: string | null;
  errorCode: string | null;
}

export async function clearPlatformAccountData(accountId: string): Promise<PlatformClearOutcome> {
  const desktopClient = requireDeps().getDesktopClient();
  const platformLoginFlow = requireDeps().getPlatformLoginFlow();
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin || platformLoginFlow.active || platformIPC.isBusy('request-collect')) {
    throw new PlatformBrowserError('platform_profile_busy', '平台登录正在进行，请先完成或关闭它');
  }
  const auth = await desktopClient.getAuthContext();
  // 找出该账号在本设备上的连接。用 mine.list 而不是本地猜 ID。
  const connections = await desktopClient.listPlatformConnections().catch(() => []);
  const target = connections.find((c) => String(c.account_id ?? '').toLowerCase() === accountId.toLowerCase() && c.state !== 'revoked');
  if (!target) {
    // 服务端已经没有该连接：本机可能还有残留目录，按平台清理一次。
    return { performed: true, revoked: false, removed: false, connectionId: null, errorCode: null };
  }
  const connectionId = String(target.id);
  const platform = String(target.platform ?? '');
  await desktopClient.revokePlatformConnection(connectionId);
  // 服务端回收成功后才删本机 profile。
  const removed = await removeConnectionNamespace(await app.getPath('userData'), {
    userId: auth.userId,
    platform,
    connectionId: accountProfileSlot({ ...auth, origin: serviceNamespace, workspaceId: String(target.workspace_id), accountId, platform })
  });
  console.error('[platform-clear]', JSON.stringify({ revoked: true, removed: removed.removed }));
  return { performed: true, revoked: true, removed: removed.removed, connectionId, errorCode: null };
}

// ---------- 无主 profile 目录扫描（DEV-PS26 / 20 文档 §5.4） ----------
//
// "无主目录"指本机存在、但服务端已不认识（连接被撤销/账号被删除/换了设备）的 profile。
// 它们不会自动消失，会一直占磁盘，还留着平台登录态。
// 策略：只扫描与计数，不自动删除——删除必须由用户确认，且要确认浏览器未占用目录。

interface OrphanProfileSummary {
  xhs: number;
  wechat_mp: number;
  total: number;
}

// countOrphanProfiles 对比本机目录与服务端连接列表，返回各平台的待清理数量。
// 服务端不可达时返回 null（不把"读不到"当成"没有无主目录"）。
async function countOrphanProfiles(): Promise<OrphanProfileSummary | null> {
  const desktopClient = requireDeps().getDesktopClient();
  if (!desktopClient) return null;
  let auth;
  try {
    auth = await desktopClient.getAuthContext();
  } catch {
    return null;
  }
  let connections: Array<Record<string, unknown>>;
  try {
    connections = await desktopClient.listPlatformConnections();
  } catch {
    // 服务端读不到就不下结论，避免把网络问题显示成"有 N 个待清理"。
    return null;
  }
  const userData = await app.getPath('userData');
  const out: OrphanProfileSummary = { xhs: 0, wechat_mp: 0, total: 0 };
  for (const platform of ['xhs', 'wechat_mp'] as const) {
    const known = connections
      .filter((c) => String(c.platform ?? '') === platform)
      .map((c) => String(c.id ?? ''))
      .filter((id) => id !== '');
    const orphans = await orphanConnections(userData, { userId: auth.userId, platform }, known)
      .catch(() => [] as string[]);
    out[platform] = orphans.length;
    out.total += orphans.length;
  }
  return out;
}

interface OrphanClearOutcome {
  performed: boolean;
  platform: PlatformLoginPlatform;
  found: number;
  removed: number;
  // 浏览器占用目录时删不掉，如实报告，不假装成功。
  skipped: number;
  errorCode: string | null;
}

// clearOrphanProfiles 清理某一平台的无主 profile 目录。
//
// 安全边界：
//  - 只处理**服务端不认识**的连接目录，绝不动仍在服务端登记的那条；
//  - 单个平台的显式调用，不提供"全部清理"；
//  - 删不掉的（浏览器占用）如实计入 skipped，不重试、不强行删。
async function clearOrphanProfiles(platform: PlatformLoginPlatform): Promise<OrphanClearOutcome> {
  const desktopClient = requireDeps().getDesktopClient();
  const platformLoginFlow = requireDeps().getPlatformLoginFlow();
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin || platformLoginFlow.active || platformIPC.isBusy('request-collect')) {
    throw new PlatformBrowserError('platform_profile_busy', '平台登录正在进行，请先完成或关闭它');
  }
  const auth = await desktopClient.getAuthContext();
  const connections = await desktopClient.listPlatformConnections();
  const known = connections
    .filter((c) => String(c.platform ?? '') === platform)
    .map((c) => String(c.id ?? ''))
    .filter((id) => id !== '');
  const userData = await app.getPath('userData');
  const orphans = await orphanConnections(userData, { userId: auth.userId, platform }, known);
  let removed = 0;
  for (const connectionId of orphans) {
    const result = await removeConnectionNamespace(userData, {
      userId: auth.userId, platform, connectionId
    }).catch(() => ({ removed: false }));
    if (result.removed) removed += 1;
  }
  console.error('[platform-clear-orphans]', JSON.stringify({
    platform, found: orphans.length, removed
  }));
  return {
    performed: true,
    platform,
    found: orphans.length,
    removed,
    skipped: orphans.length - removed,
    errorCode: null
  };
}
// writeAccountProfileMeta 写"账号 slot"的 meta.json。
//
// 采集时必须靠它确认"这条 run 属于本机已登录的这个账号"。账号 slot 的目录名由
// `accountProfileSlot()` 按 (origin,user,workspace,device,platform,account) 派生，
// 与登录时的"连接命名空间"目录是**两套目录**：
//   - 连接命名空间（connectionNamespaceId）：承载平台登录态，浏览器 profile 实际所在；
//   - 账号 slot：只记归属元数据，供调度侧确认 run 与账号的对应关系。
// 两个平台在登录成功后都必须写，否则自动采集一律被判 login_required。
async function writeAccountProfileMeta(input: {
  auth: { userId: string; workspaceId: string; deviceId: string };
  accountId: string;
  platform: PlatformLoginPlatform;
  externalAccountKey: string;
  connectionId: string;
}): Promise<void> {
  const userData = await app.getPath('userData');
  const profileDir = connectionProfileDir(userData, {
    userId: input.auth.userId,
    platform: input.platform,
    connectionId: input.connectionId
  });
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.writeFile(profileMetaPath(profileDir), JSON.stringify(buildProfileMeta({
    origin: serviceNamespace,
    userId: input.auth.userId,
    workspaceId: input.auth.workspaceId,
    deviceId: input.auth.deviceId,
    platform: input.platform,
    connectionId: input.connectionId,
    externalAccountKey: input.externalAccountKey,
    // 归属字段：采集侧 readAccountProfile 会校验这个 accountId。
    accountId: input.accountId,
    slotId: input.connectionId
  })), { encoding: 'utf8', mode: 0o600 });
}

// WECHAT_IDENTITY_PATH 是公众号账号列表接口。它只在页面首次进后台时由页面自己发起，
// 参数含时效性签名，构造请求恒回 `{"ret":200009}`（2026-10-21 实测），只能监听。
const WECHAT_IDENTITY_PATH = '/cgi-bin/switchacct';

// waitForWechatIdentity 等用户扫码进入后台，并在进入的瞬间捕获 switchacct。
// switchacct 是页面自己发的，且有签名；只能靠“监听已注册 + 页面跳转”触发，
// 因此这里循环：重新注册监听 → 导航到根 → 看是否捕获到。
// 已经登录时会立刻触发；停在扫码页时会一直等，直到超时。
async function waitForWechatIdentity(
  session: PlatformLoginSession,
  options: { onChallenge?: (outcome: ChallengeOutcome) => void } = {}
): Promise<unknown> {
  const deadline = Date.now() + PLATFORM_LOGIN_TIMEOUT_MS;
  let attempts = 0;
  let lastChallenge = '';
  while (Date.now() < deadline) {
    attempts += 1;
    const collected = session.cdp.collectResponses(WECHAT_IDENTITY_PATH, 12_000);
    await session.cdp.request('Page.navigate', { url: 'https://mp.weixin.qq.com/' }, 30_000).catch(() => undefined);
    const captured = await collected;
    if (captured !== null) return captured;
    if (options.onChallenge && attempts % 2 === 0) {
      const challenge = await probeLoginChallenge(session);
      if (challenge && challenge.kind !== 'none') {
        const key = `${challenge.vendor}:${challenge.kind}`;
        if (key !== lastChallenge) {
          lastChallenge = key;
          options.onChallenge(challenge);
        }
      }
    }
    // 没捕获到：可能还在扫码页，等一会儿再重试。
    await new Promise<void>((resolve) => setTimeout(resolve, PLATFORM_LOGIN_POLL_MS));
  }
  return undefined;
}

// finishWechatLogin 用导航期间捕获的 switchacct 响应完成公众号连接建立。
async function finishWechatLogin(accountId: string, payload: unknown): Promise<PlatformLoginOutcome> {
  const desktopClient = requireDeps().getDesktopClient();
  const identity = parseWechatIdentity(payload);
  const capabilities = probeWechatCapabilities({
    backendLoggedIn: true,
    identity,
    listReadable: true,
    now: new Date().toISOString()
  }) as unknown as Record<string, unknown>;
  const created = await desktopClient!.createPlatformConnection({
    accountId,
    externalAccountKey: identity.externalAccountKey,
    consentVersion: PLATFORM_CONSENT_VERSION
  });
  const connectionId = typeof created.id === 'string' ? created.id : null;
  if (connectionId) {
    await desktopClient!.verifyPlatformConnection({
      connectionId,
      externalAccountKey: identity.externalAccountKey,
      capabilities
    });
    // 与小红书一致：写账号 slot 的 meta，否则自动采集找不到归属会判 login_required。
    const loginAuth = await desktopClient!.getAuthContext();
    await writeAccountProfileMeta({
      auth: loginAuth,
      accountId,
      platform: 'wechat_mp',
      externalAccountKey: identity.externalAccountKey,
      connectionId: accountProfileSlot({ ...loginAuth, origin: serviceNamespace, accountId, platform: 'wechat_mp' })
    });
  }
  return {
    opened: true,
    connected: true,
    externalAccountKey: identity.externalAccountKey,
    connectionId,
    displayName: identity.originalID || null,
    timedOut: false,
    attempts: 1
  };
}

// isLoggedInLanding 判断导航落点是否仍处于已登录的官方后台。
// 两个平台的登录页形态不同：小红书会跳到 `/login`，公众号会停在扫码页或 `cgi-bin/loginpage`。
// 只按域名与已知登录页后缀判断，不做内容嗅探。
function isLoggedInLanding(platform: PlatformLoginPlatform, landedUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(landedUrl);
  } catch {
    return false;
  }
  if (platform === 'xhs') {
    if (parsed.hostname !== 'creator.xiaohongshu.com') return false;
    return !parsed.pathname.startsWith('/login');
  }
  if (parsed.hostname !== 'mp.weixin.qq.com') return false;
  // 公众号未登录会落在 /cgi-bin/loginpage 或带 action=scanlogin 的地址。
  if (parsed.pathname.startsWith('/cgi-bin/loginpage')) return false;
  const action = parsed.searchParams.get('action') ?? '';
  if (action.includes('scanlogin')) return false;
  return true;
}

// parseRunTargets 从 run 冻结的 binding_snapshot 里取出每篇作品的绑定与发布修订。
// 服务端提交时逐项比较，客户端必须原样回传，不能自己推断或升级修订。
function parseRunTargets(snapshot: unknown): Map<string, { bindingRevision: number; publishRevision: number }> {
  const out = new Map<string, { bindingRevision: number; publishRevision: number }>();
  if (!Array.isArray(snapshot)) return out;
  for (const item of snapshot) {
    if (!item || typeof item !== 'object') continue;
    const t = item as { external_id?: unknown; binding_revision?: unknown; publish_revision?: unknown };
    if (typeof t.external_id !== 'string' || t.external_id === '') continue;
    const bindingRevision = typeof t.binding_revision === 'number' ? t.binding_revision : Number.NaN;
    const publishRevision = typeof t.publish_revision === 'number' ? t.publish_revision : Number.NaN;
    if (!Number.isFinite(bindingRevision) || !Number.isFinite(publishRevision)) continue;
    out.set(t.external_id.toLowerCase(), { bindingRevision, publishRevision });
  }
  return out;
}

// resolveRunAccountKey 取本次任务的外部账号键。
// 优先用 run 冻结的 binding_snapshot（服务端权威值）；该快照在首版只含作品绑定时为空，
// 因此回退到连接摘要里的 external_account_key。都取不到时返回 null，
// 由调用方明确报错，不用空字符串让服务端静默丢观测。
async function resolveRunAccountKey(run: { connection_id: string; binding_snapshot: unknown }): Promise<string | null> {
  const desktopClient = requireDeps().getDesktopClient();
  const snapshot = run.binding_snapshot;
  if (snapshot && typeof snapshot === 'object') {
    const key = (snapshot as { external_account_key?: unknown }).external_account_key;
    if (typeof key === 'string' && key.trim() !== '') return key.trim();
  }
  const summary = await desktopClient!.getPlatformConnectionSummary(run.connection_id).catch((error) => {
    console.error('[collect] connection summary failed', describeError(error));
    return null;
  });
  const fromSummary = summary && typeof summary.external_account_key === 'string' ? summary.external_account_key : '';
  if (fromSummary.trim() === '') {
    console.error('[collect] summary missing key', JSON.stringify({
      hasSummary: summary !== null,
      keys: summary ? Object.keys(summary).slice(0, 20) : []
    }));
  }
  return fromSummary.trim() !== '' ? fromSummary.trim() : null;
}

// resolveCollectProfileDir 复用登录时的 profile 命名空间，保证采集用的是同一份会话。
async function resolveCollectProfileDir(platform: string): Promise<string> {
  const desktopClient = requireDeps().getDesktopClient();
  const auth = await desktopClient!.getAuthContext();
  return connectionProfileDir(await app.getPath('userData'), {
    userId: auth.userId,
    platform,
    connectionId: auth.connectionNamespaceId
  });
}

// 浏览器探测结论只在主进程缓存：一次会话里浏览器不会中途换，重复探测只会反复拉起进程。
// 缓存的是结论而不是候选路径，对外结构里不出现任何本机路径。
export interface PlatformBrowserStatus {
  state: 'ready' | 'unsupported' | 'launch_failed'
  family: string | null
  name: string | null
  version: string | null
  major: number | null
  errorCode: string | null
  checkedAt: string
}

let platformBrowserStatus: PlatformBrowserStatus | null = null;
let platformBrowserProbe: Promise<PlatformBrowserStatus> | null = null;

export async function readPlatformBrowserStatus(force = false): Promise<PlatformBrowserStatus> {
  if (!force && platformBrowserStatus) return platformBrowserStatus;
  if (!force && platformBrowserProbe) return platformBrowserProbe;
  platformBrowserProbe = probePlatformBrowserOnce().finally(() => {
    platformBrowserProbe = null;
  });
  return platformBrowserProbe;
}

async function probePlatformBrowserOnce(): Promise<PlatformBrowserStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const candidate = await findPlatformBrowser();
    // 用一次性临时 profile 探测，不碰任何真实连接的会话目录。
    const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-platform-probe-'));
    try {
      const probe = await probePlatformBrowser({ candidate, profileDir: probeDir });
      platformBrowserStatus = {
        state: 'ready',
        family: probe.family,
        name: probe.name,
        version: probe.version,
        major: probe.major,
        errorCode: null,
        checkedAt
      };
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    const code = error instanceof PlatformBrowserError ? error.code : 'platform_browser_launch_failed';
    platformBrowserStatus = {
      state: code === 'platform_browser_unsupported' ? 'unsupported' : 'launch_failed',
      family: null,
      name: null,
      version: null,
      major: null,
      errorCode: code,
      checkedAt
    };
  }
  return platformBrowserStatus;
}
