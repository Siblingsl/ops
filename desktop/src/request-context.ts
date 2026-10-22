import { randomBytes } from 'node:crypto';

export type DesktopMode = 'server' | 'desktop';

const MANAGEMENT_REQUEST_MARKER = 'X-OPS-Desktop-Management-Request';
const MANAGEMENT_REQUEST_MARKER_TTL_MS = 30_000;

export class ManagementRequestRegistry {
  private readonly markers = new Map<string, { requestUrl: string; method: string; expiresAt: number }>();

  constructor(private readonly businessOrigin: string) {}

  issue(requestUrl: string, method: string): string {
    if (!isBusinessApiUrl(requestUrl, this.businessOrigin)) throw new Error('管理请求目标无效。');
    this.removeExpired();
    const marker = randomBytes(32).toString('hex');
    this.markers.set(marker, {
      requestUrl: new URL(requestUrl).toString(),
      method: method.toUpperCase(),
      expiresAt: Date.now() + MANAGEMENT_REQUEST_MARKER_TTL_MS
    });
    return marker;
  }

  consume(marker: string, requestUrl: string, method: string): boolean {
    const expected = this.markers.get(marker);
    if (!expected) return false;
    this.markers.delete(marker);
    let normalizedUrl: string;
    try {
      normalizedUrl = new URL(requestUrl).toString();
    } catch {
      return false;
    }
    return expected.expiresAt > Date.now()
      && expected.method === method.toUpperCase()
      && expected.requestUrl === normalizedUrl
      && isBusinessApiUrl(requestUrl, this.businessOrigin);
  }

  discard(marker: string): void {
    this.markers.delete(marker);
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [marker, expected] of this.markers) {
      if (expected.expiresAt <= now) this.markers.delete(marker);
    }
  }
}

export function isManagementRequestMarker(name: string): boolean {
  return name.toLowerCase() === MANAGEMENT_REQUEST_MARKER.toLowerCase();
}

export interface AppliedDesktopRequestContext {
  deviceId?: string;
  connectionId?: string;
  generation?: number;
  routeRevision?: number;
}

export interface DesktopRouteSelection {
  task_type: string;
  execution_location: 'desktop' | 'server' | 'disabled';
  provider_id: string | null;
  model: string;
  fallback_provider_id: string | null;
  fallback_model: string;
}

export function prepareDesktopRouteApplication(input: {
  appliedRoutes: DesktopRouteSelection[];
  draftRoutes?: DesktopRouteSelection[];
  draftRevision?: number;
  policyRevision: number;
}): { routes: DesktopRouteSelection[]; needsCommit: boolean } {
  if (input.draftRoutes && input.draftRevision !== input.policyRevision) {
    throw new Error('任务映射已变化，请刷新后重新保存草稿。');
  }
  const routes = input.draftRoutes ?? input.appliedRoutes;
  if (!routes.some((route) => route.execution_location === 'desktop')) {
    throw new Error('请至少为一个任务配置本机模型。');
  }
  return {
    routes,
    needsCommit: Boolean(input.draftRoutes && routeSignature(input.draftRoutes) !== routeSignature(input.appliedRoutes))
  };
}

export interface BuildDesktopRequestHeadersInput {
  requestUrl: string;
  businessOrigin: string;
  trustedBusinessMainFrame: boolean;
  mode: DesktopMode;
  requestContext: AppliedDesktopRequestContext;
  requestHeaders: Record<string, string>;
}

export function isBusinessApiUrl(requestUrl: string, businessOrigin: string): boolean {
  try {
    const target = new URL(requestUrl);
    const origin = new URL(businessOrigin);
    return target.origin === origin.origin
      && (target.pathname === '/api/v1' || target.pathname.startsWith('/api/v1/'));
  } catch {
    return false;
  }
}

export function buildDesktopRequestHeaders(input: BuildDesktopRequestHeadersInput): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(input.requestHeaders).filter(([name]) => !isDesktopHeader(name))
  );
  if (input.mode !== 'desktop'
    || !input.trustedBusinessMainFrame
    || !isBusinessApiUrl(input.requestUrl, input.businessOrigin)
    || !input.requestContext.deviceId
    || !Number.isSafeInteger(input.requestContext.routeRevision)
    || (input.requestContext.routeRevision ?? 0) < 1) {
    return headers;
  }

  headers['X-OPS-Desktop-Device'] = input.requestContext.deviceId;
  if (input.requestContext.connectionId && Number.isSafeInteger(input.requestContext.generation)
    && (input.requestContext.generation ?? 0) > 0) {
    headers['X-OPS-Desktop-Connection'] = `${input.requestContext.connectionId}:${input.requestContext.generation}`;
  }
  headers['X-OPS-Desktop-Policy'] = String(input.requestContext.routeRevision);
  return headers;
}

export function shouldBlockDesktopApiRequest(input: {
  requestUrl: string;
  method?: string;
  businessOrigin: string;
  isBusinessWindow: boolean;
  trustedBusinessMainFrame: boolean;
  requestContextReady: boolean;
  mode: DesktopMode;
  forceBlock?: boolean;
}): boolean {
  if (!input.isBusinessWindow || !isBusinessApiUrl(input.requestUrl, input.businessOrigin)) return false;
  if (!isPotentialAiApiRequest(input.requestUrl, input.businessOrigin)) return false;
  if (input.forceBlock) return true;
  return input.mode === 'desktop' && (!input.trustedBusinessMainFrame || !input.requestContextReady);
}

export function isPotentialAiApiRequest(requestUrl: string, businessOrigin: string): boolean {
  if (!isBusinessApiUrl(requestUrl, businessOrigin)) return false;
  let path: string;
  try {
    path = new URL(requestUrl).pathname;
  } catch {
    return false;
  }
  return [
    /^\/api\/v1\/ai\/status$/,
    /^\/api\/v1\/agent(?:\/|$)/,
    /^\/api\/v1\/accounts\/[^/]+\/(?:brief|retrieve|memories\/distill|plan\/suggest)$/,
    /^\/api\/v1\/(?:accounts\/[^/]+\/(?:profile\/bootstrap|style-summary|metrics\/screenshots|topics\/(?:suggest|hot-suggest|score)|reviews(?:\/attribution)?|daily(?:\/regenerate)?|hot\/refresh|strategy\/(?:options|revise)|plan\/suggest)|topics\/[^/]+\/suggest|series\/[^/]+\/suggest|inbox\/[^/]+\/triage|materials\/(?:extract|tag-suggest))$/,
    /^\/api\/v1\/(?:works\/[^/]+\/(?:read-through|outline\/(?:generate|review)|storyboard\/generate|generate-image|cards\/[^/]+\/generate-image|titles|summary|organize-notes|xhs\/pages|checks|derive|copilot|lint|polish-check|tag-suggest|layout-suggest|breakdown)|sections\/[^/]+\/(?:draft|edit|rewrite|image-suggest|hooks|continue)|panels\/[^/]+\/(?:text|generate-image)|assets\/[^/]+\/alt-suggestion|check-items\/[^/]+\/fix-suggest)$/,
    /^\/api\/v1\/(?:references\/[^/]+\/paste|daily\/[^/]+\/regenerate|plan-slots\/[^/]+\/regenerate|prompt-eval\/(?:runs|replay)|model-providers\/[^/]+\/(?:test|selftest))$/
  ].some((pattern) => pattern.test(path));
}

function isDesktopHeader(name: string): boolean {
  return name.toLowerCase().startsWith('x-ops-desktop-');
}

function routeSignature(routes: DesktopRouteSelection[]): string {
  return JSON.stringify([...routes].sort((left, right) => left.task_type.localeCompare(right.task_type))
    .map((route) => [route.task_type, route.execution_location, route.provider_id, route.model,
      route.fallback_provider_id, route.fallback_model]));
}
