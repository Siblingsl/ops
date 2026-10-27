interface DesktopSettingsInfo {
  appVersion: string;
  apiOrigin: string;
  connectionState: 'online' | 'offline' | 'unknown';
  failureReason: 'unreachable' | 'icp-block' | 'render-failed';
  systemInfo: { version: string; dev: boolean; dataBytes: number } | null | undefined;
  aiStatus: string;
  clientState: {
    signedIn: boolean;
    username: string;
    workspaceName: string;
    reauthRequired: boolean;
    storageAvailable: boolean;
    localConfigAvailable: boolean;
    deviceRegistered: boolean | null;
    modelCount: number | null;
    activeModelRequests: number;
    channelState: 'disconnected' | 'connecting' | 'ready' | 'error';
    channelMessage: string;
    mode: 'server' | 'desktop';
    routeRevision: number;
    deviceId: string;
  };
}

interface DesktopDeviceState {
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    version: string;
    revoked_at: string | null;
    created_at: string;
    last_seen_at: string | null;
  }>;
  reauthRequired: boolean;
}

interface DesktopRouteInput {
  task_type: string;
  execution_location: 'desktop' | 'server' | 'disabled';
  provider_id: string | null;
  model: string;
  fallback_provider_id: string | null;
  fallback_model: string;
}

interface DesktopRouteState {
  routes: DesktopRouteInput[];
  policy_revision: number;
  draft_routes?: DesktopRouteInput[];
  draft_revision?: number;
  has_draft?: boolean;
}

interface DesktopPolicyState {
  globalEnabled: boolean;
  policy: {
    workspace_id: string;
    enabled: boolean;
    allow_member_endpoints: boolean;
    authorization_revision: number;
  };
}

interface DesktopRouteOptions {
  routeTypes: Array<{ task_type: string; label: string }>;
  serverModels: Array<{ id: string; name: string; models: string[]; status: string }>;
  desktopRoutes: DesktopRouteState;
  desktopModels: DesktopPublicModel[];
}

interface DesktopPublicModel {
  providerId: string;
  name: string;
  baseUrl: string;
  models: string[];
  allowedImageHosts: string[];
  endpointKind: 'loopback' | 'public';
  proxyMode: 'system' | 'manual' | 'direct';
  proxyUrl: string;
  configRevision: number;
  hasKey: boolean;
  keyMask: string;
  hasProxyAuth: boolean;
}

interface SaveModelInput {
  providerId?: string;
  configRevision?: number;
  name: string;
  baseUrl: string;
  models: string[];
  apiKey: string;
  allowedImageHosts?: string[];
  proxyMode?: 'system' | 'manual' | 'direct';
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
}

interface DesktopPlatformBrowserStatus {
  state: 'ready' | 'unsupported' | 'launch_failed';
  family: string | null;
  name: string | null;
  version: string | null;
  major: number | null;
  errorCode: string | null;
  checkedAt: string;
}

interface Window {
  opsDesktopSettings: {
    getInfo(): Promise<DesktopSettingsInfo>;
    exportDiagnostics(): Promise<boolean>;
    getModels(): Promise<DesktopPublicModel[]>;
    getPolicy(): Promise<DesktopPolicyState>;
    setPolicy(policy: { enabled: boolean; allowMemberEndpoints: boolean }): Promise<DesktopPolicyState['policy']>;
    getDevices(): Promise<DesktopDeviceState>;
    revokeDevice(input: { deviceId: string; password: string }): Promise<void>;
    getRoutes(): Promise<DesktopRouteOptions>;
    saveRoutes(input: { routes: DesktopRouteInput[]; expectedRevision: number }): Promise<DesktopRouteState>;
    startModelTest(input: { providerId: string; model: string }): Promise<{ test_id: string; status: string; stage: string }>;
    getModelTest(testId: string): Promise<Record<string, unknown>>;
    applyMode(mode: 'server' | 'desktop'): Promise<boolean>;
    reauthenticate(password: string): Promise<void>;
    clearAccountData(): Promise<boolean>;
    saveModel(input: SaveModelInput): Promise<DesktopPublicModel[]>;
    deleteModel(input: { providerId: string; configRevision: number }): Promise<DesktopPublicModel[] | null>;
    connectAI(): Promise<void>;
    disconnectAI(): Promise<void>;
    retryBusinessPage(): Promise<void>;
    openLoginPage(): Promise<void>;
    openSettings(): Promise<void>;
    takePlatformLoginTarget(): Promise<{ accountId: string; platform: 'xhs' | 'wechat_mp' | 'toutiao' } | null>;
    onPlatformLoginTarget(listener: (target: { accountId: string; platform: 'xhs' | 'wechat_mp' | 'toutiao' }) => void): () => void;
    closeLocalWindow(): Promise<void>;
    reportLocalState(state: { dirty: boolean; busy: boolean }): void;
    platformCommand(envelope: { v: number; id: string; cmd: string; payload?: unknown }): Promise<unknown>;
    platformBrowser(input?: { refresh?: boolean }): Promise<DesktopPlatformBrowserStatus>;
  };
}
