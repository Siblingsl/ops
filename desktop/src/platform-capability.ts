// 平台采集（D-129 / 20 文档 §11.1）客户端的纯协议判断。这里不碰 Electron，
// 便于用 node --test 直接覆盖“旧服务器不支持时不调用未知端点”等规则。

export const PLATFORM_REGISTER_PURPOSE = 'platform_collection';

// 客户端只认这些操作名与端点；服务端即使公布更多操作，也不会被本客户端调用，
// 避免服务器通过能力接口扩大客户端可发起的请求范围。
export const PLATFORM_OPERATION_PATHS: Readonly<Record<string, { method: string; path: string }>> = Object.freeze({
  'platform.device.register': { method: 'POST', path: '/api/v1/desktop/platform/devices' },
  'platform.connection.create': { method: 'POST', path: '/api/v1/desktop/platform/connections' },
  'platform.connection.mine.list': { method: 'GET', path: '/api/v1/desktop/platform/connections/mine' },
  'platform.presence': { method: 'POST', path: '/api/v1/desktop/platform/presence' },
  'platform.run.claim': { method: 'POST', path: '/api/v1/desktop/platform/runs/claim' }
});

export interface PlatformCollectionCapability {
  protocol_version: number;
  enabled: boolean;
  platforms: string[];
  purpose: string;
  operations: string[];
  limits: Record<string, number>;
}

export class PlatformCollectionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformCollectionUnsupportedError';
  }
}

// 旧服务器没有 platform_collection 字段时明确“不支持”，不能猜测端点或降级调用 AI 接口。
export function parsePlatformCollectionCapability(
  payload: unknown,
  supportedProtocolVersion: number
): PlatformCollectionCapability {
  if (!payload || typeof payload !== 'object' || !('platform_collection' in payload)) {
    throw new PlatformCollectionUnsupportedError('线上服务不支持平台数据采集，请先升级服务端。');
  }
  const raw = (payload as { platform_collection?: unknown }).platform_collection;
  if (!raw || typeof raw !== 'object') {
    throw new PlatformCollectionUnsupportedError('线上服务的平台采集能力不完整，请先升级服务端。');
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.protocol_version !== 'number' || !Number.isInteger(candidate.protocol_version)) {
    throw new PlatformCollectionUnsupportedError('线上服务的平台采集协议版本无效。');
  }
  if (candidate.protocol_version !== supportedProtocolVersion) {
    throw new PlatformCollectionUnsupportedError(
      `本客户端与线上服务的平台采集协议不兼容（客户端 ${supportedProtocolVersion}，服务端 ${candidate.protocol_version}），请升级客户端。`
    );
  }
  if (typeof candidate.purpose !== 'string' || candidate.purpose !== PLATFORM_REGISTER_PURPOSE) {
    throw new PlatformCollectionUnsupportedError('线上服务未登记本客户端使用的设备用途标识。');
  }
  if (!Array.isArray(candidate.operations) || candidate.operations.some((op) => typeof op !== 'string')) {
    throw new PlatformCollectionUnsupportedError('线上服务的平台操作清单无效。');
  }
  if (!Array.isArray(candidate.platforms) || candidate.platforms.some((p) => typeof p !== 'string')) {
    throw new PlatformCollectionUnsupportedError('线上服务的平台清单无效。');
  }
  const limits: Record<string, number> = {};
  if (candidate.limits && typeof candidate.limits === 'object') {
    for (const [key, value] of Object.entries(candidate.limits as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) limits[key] = value;
    }
  }
  return {
    protocol_version: candidate.protocol_version,
    enabled: candidate.enabled === true,
    platforms: candidate.platforms as string[],
    purpose: candidate.purpose,
    operations: candidate.operations as string[],
    limits
  };
}

// 只有客户端内置且服务端也公布的操作才可发起；任一侧缺失都视为不支持。
export function resolvePlatformEndpoint(
  capability: PlatformCollectionCapability,
  operation: string
): { method: string; path: string } {
  const endpoint = PLATFORM_OPERATION_PATHS[operation];
  if (!endpoint) throw new PlatformCollectionUnsupportedError(`本客户端不支持平台操作 ${operation}。`);
  if (!capability.operations.includes(operation)) {
    throw new PlatformCollectionUnsupportedError(`线上服务未开放平台操作 ${operation}，请升级服务端。`);
  }
  return endpoint;
}
