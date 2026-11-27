export const PRODUCTION_API_ORIGIN = 'https://ops-api.88813888.xyz';
export const PRODUCTION_BUSINESS_UI_ORIGIN = 'ops-desktop://business';
// 稳定的本机数据命名空间，保留旧发行版中 AI 配置与平台 profile 的归属键；不用于网络请求。
export const PRODUCTION_SERVICE_NAMESPACE = 'https://ops.88813888.xyz';
export const DEFAULT_DEVELOPMENT_ORIGIN = 'http://localhost:5174';

function parseLoopbackOrigin(developmentUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(developmentUrl);
  } catch {
    throw new Error('OPS_DESKTOP_DEV_URL 必须是有效的本地开发 URL。');
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (!isLoopback || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('开发 URL 只允许 localhost、127.0.0.1 或 ::1 上的 HTTP(S) 服务。');
  }
  return parsed;
}

export function resolveBusinessOrigin(isPackaged: boolean, developmentUrl?: string): string {
  if (isPackaged) return PRODUCTION_BUSINESS_UI_ORIGIN;
  if (!developmentUrl) return DEFAULT_DEVELOPMENT_ORIGIN;
  return parseLoopbackOrigin(developmentUrl).origin;
}

/**
 * 已打包客户端默认连接生产 API。只有在显式设置 OPS_DESKTOP_ALLOW_LOCAL_API=1
 * 且 OPS_DESKTOP_DEV_URL 为回环地址时，才允许把 API 指向本地隔离栈；
 * 业务 UI 仍然使用 ops-desktop://business，避免整包误连生产或误连本机。
 */
export function resolvePackagedLocalApiOrigin(developmentUrl?: string): string | undefined {
  if (!developmentUrl) return undefined;
  return parseLoopbackOrigin(developmentUrl).origin;
}

export function resolveApiOrigin(isPackaged: boolean, uiOrigin: string): string {
  return isPackaged ? PRODUCTION_API_ORIGIN : uiOrigin;
}

export function resolveServiceNamespace(isPackaged: boolean, uiOrigin: string): string {
  return isPackaged ? PRODUCTION_SERVICE_NAMESPACE : uiOrigin;
}

export function isBusinessOriginUrl(value: string, businessOrigin: string): boolean {
  let url: URL;
  let expectedOrigin: URL;
  try {
    url = new URL(value);
    expectedOrigin = new URL(businessOrigin);
  } catch {
    return false;
  }

  if (expectedOrigin.origin === 'null') {
    return url.origin === 'null'
      && url.protocol === expectedOrigin.protocol
      && url.host === expectedOrigin.host
      && !url.username
      && !url.password;
  }
  return url.origin === expectedOrigin.origin;
}
