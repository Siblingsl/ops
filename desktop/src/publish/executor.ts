// 桌面发布队列执行器：claim → heartbeat → preflight → fill → readback → result。
// 普通填写只到回读，不自动点国内平台发布；只有服务端明确发放 intent=submit
// （用户在任务卡点“立即提交”）才走提交分支，且匹配页必须恰好 1 个。
// 本文件只通过注入的 claim/heartbeat/result 访问服务端，不写数据库、不直接改作品发布状态。
import type { DesktopPublishAdapterRegistry } from './registry';
import { publishExecutorErrorCode, withPublishTimeout } from './errors';
import type { PublishFillRequest, PublishFillResult, PublishMode } from './types';

export interface PublishTaskEnvelope {
  taskId: string;
  workspaceId: string;
  accountId: string;
  workId: string;
  platform: string;
  manifest: Record<string, unknown>;
  mode: PublishMode;
  accountName?: string;
  /** 服务端 claim 返回；submit 表示这是用户显式 submit-now 的一次性提交，不是普通填写。 */
  intent?: 'fill' | 'submit';
}

export interface DesktopPublishTimeouts {
  preflight: number;
  fill: number;
  readback: number;
  submit: number;
}

export const DEFAULT_DESKTOP_PUBLISH_TIMEOUTS: DesktopPublishTimeouts = {
  preflight: 30_000,
  fill: 120_000,
  readback: 60_000,
  submit: 60_000,
};

export interface DesktopPublishDeps {
  claim: () => Promise<PublishTaskEnvelope | null>;
  heartbeat: (taskId: string) => Promise<void>;
  result: (taskId: string, result: PublishFillResult) => Promise<void>;
  registry: DesktopPublishAdapterRegistry;
  timeouts?: Partial<DesktopPublishTimeouts>;
  explicitSubmitNow?: boolean;
}

function failed(err: unknown): PublishFillResult {
  return {
    state: 'failed',
    errorCode: publishExecutorErrorCode(err),
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}

/** 单次队列轮次；没有可领取任务返回 null。失败结果也会回执，不能静默丢弃。 */
export async function runDesktopPublishTask(deps: DesktopPublishDeps): Promise<PublishFillResult | null> {
  const task = await deps.claim();
  if (!task) return null;
  const adapter = deps.registry.get(task.platform);
  if (!adapter) {
    const result = failed(new Error(`未注册 ${task.platform} 发布适配器`));
    result.errorCode = 'executor_not_registered';
    await deps.result(task.taskId, result);
    return result;
  }
  const timeouts = { ...DEFAULT_DESKTOP_PUBLISH_TIMEOUTS, ...(deps.timeouts ?? {}) };
  // 小红书风控红线：历史/异常 submit 意图也不能进入点击发布分支，直接回执失败。
  if (task.platform === 'xhs' && task.intent === 'submit') {
    const blocked: PublishFillResult = {
      state: 'failed',
      errorCode: 'direct_submit_not_supported',
      errorMessage: '小红书不允许由 OPS 直接点击发布；请保存草稿后由用户在小红书草稿箱发布',
    };
    await deps.result(task.taskId, blocked);
    return blocked;
  }
  if (task.intent === 'submit') {
    const req: PublishFillRequest = {
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      workId: task.workId,
      platform: task.platform,
      manifest: task.manifest,
      mode: task.mode,
      accountName: task.accountName,
      explicitSubmitNow: true,
    };
    let submitResult: PublishFillResult;
    try {
      // submit-now 不再 heartbeat（任务仍是 filled，不进入 filling 租约）；
      // 先重新回读，确保页面仍是 manifest 的这一篇，再交给适配器做匹配页校验与点击。
      await withPublishTimeout(adapter.preflight(req), timeouts.preflight, 'preflight');
      const readback = await withPublishTimeout(adapter.readback(req), timeouts.readback, 'readback');
      if (!readback.readback || readback.readback.ok !== true) {
        submitResult = {
          ...readback,
          state: 'failed',
          errorCode: 'readback_mismatch',
          errorMessage: '提交前回读不一致，未点击发布',
        };
      } else {
        submitResult = await withPublishTimeout(adapter.submit(req), timeouts.submit, 'submit');
      }
    } catch (err) {
      submitResult = failed(err);
    }
    await deps.result(task.taskId, submitResult);
    return submitResult;
  }
  await deps.heartbeat(task.taskId);

  const req: PublishFillRequest = {
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    accountId: task.accountId,
    workId: task.workId,
    platform: task.platform,
    manifest: task.manifest,
    mode: task.mode,
    accountName: task.accountName,
    explicitSubmitNow: deps.explicitSubmitNow === true,
  };

  let result: PublishFillResult;
  try {
    await withPublishTimeout(adapter.preflight(req), timeouts.preflight, 'preflight');
    result = await withPublishTimeout(adapter.fill(req), timeouts.fill, 'fill');
  } catch (err) {
    result = failed(err);
  }
  if (result.state === 'awaiting_user' || result.state === 'failed' || result.errorCode) {
    await deps.result(task.taskId, result);
    return result;
  }

  try {
    result = await withPublishTimeout(adapter.readback(req), timeouts.readback, 'readback');
    if (result.state === 'failed' || result.errorCode) {
      await deps.result(task.taskId, result);
      return result;
    }
    const readbackOK = result.readback && result.readback.ok === true;
    if (!readbackOK) {
      result = {
        ...result,
        state: 'failed',
        errorCode: 'readback_mismatch',
        errorMessage: '回读不一致，禁止提交'
      };
      await deps.result(task.taskId, result);
      return result;
    }
    if (task.mode === 'api' && deps.explicitSubmitNow === true) {
      result = await withPublishTimeout(adapter.submit(req), timeouts.submit, 'submit');
    }
  } catch (err) {
    result = failed(err);
  }
  await deps.result(task.taskId, result);
  return result;
}
