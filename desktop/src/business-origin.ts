export const PRODUCTION_ORIGIN = 'https://ops.88813888.xyz';
export const DEFAULT_DEVELOPMENT_ORIGIN = 'http://localhost:5174';

export function resolveBusinessOrigin(isPackaged: boolean, developmentUrl?: string): string {
  if (isPackaged) return PRODUCTION_ORIGIN;
  if (!developmentUrl) return DEFAULT_DEVELOPMENT_ORIGIN;

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

  return parsed.origin;
}
