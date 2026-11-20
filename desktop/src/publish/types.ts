// REF41 P8：桌面发布执行器契约。与 Go 侧 PublishExecutor 保持一致，
// 执行器只做单次动作并返回结果，不写库、不直接改作品发布状态。
export type PublishMode = 'api' | 'desktop' | 'manual';

/** REF41 F5：服务端浏览器任务目的枚举；桌面发布目前使用 publish_fill。 */
export type BrowserPolicyPurpose = 'publish_fill' | 'publish_health' | 'publish_patrol' | 'benchmark_observe' | 'followers';

export interface BrowserPolicyCheckInput {
  accountId: string;
  purpose: BrowserPolicyPurpose;
  url: string;
  tabCount: number;
  action?: string;
}

export interface BrowserPolicyGate {
  check(input: BrowserPolicyCheckInput): Promise<{ ok: boolean; reason?: string }>;
}


export interface PublishFillRequest {
  taskId: string;
  workspaceId: string;
  accountId: string;
  workId: string;
  platform: string;
  manifest: Record<string, unknown>;
  mode: PublishMode;
  /** 桌面侧当前登录账号名；服务端 claim 未回传时由 profile 注入。 */
  accountName?: string;
  /** 只有用户显式 submit-now 才允许 API 通道提交。 */
  explicitSubmitNow?: boolean;
}

export interface PublishFillResult {
  state: string;
  readback?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface PublishExecutor {
  platform: string;
  name: string;
  version: string;
  preflight(req: PublishFillRequest): Promise<Record<string, unknown>>;
  fill(req: PublishFillRequest): Promise<PublishFillResult>;
  readback(req: PublishFillRequest): Promise<PublishFillResult>;
  submit(req: PublishFillRequest): Promise<PublishFillResult>;
}
