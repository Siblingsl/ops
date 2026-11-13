import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopClientHealth, PlatformIntentResult } from './ui-intents';

// Sandboxed preloads can only require Electron built-ins; keep these strings aligned with ui-intents.ts.
const CLIENT_HEALTH_CHANNEL = 'desktop-ui:client-health';
const PLATFORM_INTENT_RESULT_CHANNEL = 'desktop-ui:platform-intent-result';
const CX_LONG_IMAGE_CAPTURE_CHANNEL = 'cx-long-image:capture';

type LocalSettingsState = { dirty: boolean; busy: boolean };
type SettingsOpenListener = () => void;
type LocalSettingsStateListener = (state: LocalSettingsState) => void;
type PlatformIntentResultListener = (result: PlatformIntentResult) => void;
type ClientHealthListener = (health: DesktopClientHealth) => void;
type CXLongImageCaptureResult =
  | { ok: false; code: string; message: string }
  | {
    ok: true;
    buildId: string;
    sourceHash: string;
    png: Uint8Array;
    width: number;
    height: number;
    heightCss: number;
    dpr: number;
    viewportWidth: number;
    viewportHeight: number;
    segments: number;
    captureEngine: string;
    captureEngineVersion: string;
    captureCheckScope: string;
    capturedAt: string;
    fontFamily: string;
  };

// DEV-AI27-17（W17b，A12）：本机选窗结果。handle 不透明，标题只在业务窗口内使用。
type ComputerWindowView = { pid: number; handle: string; process: string; title: string; forbidden: boolean };
type ComputerWindowListResult =
  | { ok: false; code: string; message: string }
  | { ok: true; windows: ComputerWindowView[] };

// DT-04（W17c / 27 §11.5.2）：UIA 控件树视图。C09 脱敏口径——逐控件只允许
// id/type/name/value 四键，任何多余键（如 process_path/hwnd/class_name）整批拒绝；
// 树上限 200 项与 worker 侧一致。
type ComputerUiaControl = { id: string; type: string; name: string; value: string };
type ComputerUiaViewResult =
  | { ok: false; code: string; message: string }
  | { ok: true; window: string; controls: ComputerUiaControl[] };
type ComputerUiaInvokeResult =
  | { ok: false; code: string; message: string }
  | { ok: true; action: string };

// DEV-CU P3-7（§4.12 / §P3-7）：observe 输出与 act 结果的白名单类型。
// 键集合严格按 §4.12 表：新增字段只允许追加；C09 禁止字段（process_path/
// hwnd/class_name/完整标题/进程路径）一律整批拒绝。
type ComputerUiaObserveNode = {
  role: string;
  name: string;
  value: string;
  ref_id: string;
  available_actions: string[];
  states: string[];
  bounds: { x: number; y: number; w: number; h: number };
  children: ComputerUiaObserveNode[];
  children_count: number;
  depth: number;
};
type ComputerUiaObserveResult =
  | { ok: false; code: string; message: string }
  | {
    ok: true;
    snapshot_id: string;
    revision: number;
    ref_count: number;
    complete: boolean;
    nodes_observed: number;
    truncated?: boolean;
    identity_unproven?: boolean;
    tree: ComputerUiaObserveNode;
  };
type ComputerUiaActResult =
  | { ok: false; code: string; message: string }
  | {
    ok: true;
    action: string;
    snapshot_id?: string;
    ref?: string;
    disposition: { delivery: string; retry: string };
    verification_scope?: string;
    verification_reason?: string;
    steps?: Array<{ label: string; outcome: string; mechanism: string }>;
  };
type ComputerUiaInvalidateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; cleared: number };

// DEV-AI27-A30：本机标签枚举结果（选标签授权弹窗）。origin 已由扩展按页面 URL 归一。
type BrowserTabView = { tab_id: number; title: string; origin: string; window_id: number; active: boolean };
type BrowserTabListResult =
  | { ok: false; code: string; message: string }
  | { ok: true; tabs: BrowserTabView[] };

// DEV-AI27-A30b：桥配对快照——短码核对与组装服务端 confirm 所需的最小集合。
// 快照白名单四键；pairing 白名单三键；任何多余键（如 session_key/hkdf_salt）整份拒绝，
// 会话密钥零泄漏断言在 preload 层成立（源头 pairingSnapshot 也不含）。
type BrowserPairingSnapshot = {
  state: 'unpaired' | 'pairing' | 'paired' | 'revoked';
  pairing: { code: string; expires_at: number; expired: boolean } | null;
  extension_instance_id: string | null;
  host_pid: number | null;
};
type BrowserPairingStateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; snapshot: BrowserPairingSnapshot };
type BrowserPairingConfirmResult =
  | { ok: false; code: string; message: string }
  | { ok: true; extension_instance_id: string | null };

// DEV-AI27-A3 第一片：MCP 验证结果——目录只含工具名/哈希/schema，不含任何秘密。
type McpValidateInput = {
  connection_id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
};
type McpToolDescriptorView = { name: string; description_hash: string; input_schema: unknown; output_schema?: unknown };
type McpValidateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; catalog: { tools: McpToolDescriptorView[]; server_info: { name: string; version: string; protocol_version: string }; catalog_revision: string } };

// DEV-AI27-A3 第二片：OAuth 状态摘要——永不包含令牌明文（state/expires_at/has_refresh）。
type McpOAuthStatus = { state: 'unauthorized' | 'authorizing' | 'authorized' | 'needs_reauth'; expires_at: string | null; has_refresh: boolean };
type McpOAuthStartResult = { ok: boolean; state: string; reason: string };

const OPEN_SETTINGS_CHANNEL = 'desktop-ui:open-settings';
const LOCAL_SETTINGS_STATE_CHANNEL = 'desktop-ui:local-settings-state';
const openSettingsListeners = new Set<SettingsOpenListener>();
const localSettingsStateListeners = new Set<LocalSettingsStateListener>();
const platformIntentResultListeners = new Set<PlatformIntentResultListener>();
const clientHealthListeners = new Set<ClientHealthListener>();
let pendingOpenSettings = false;
let latestLocalSettingsState: LocalSettingsState | null = null;
let latestClientHealth: DesktopClientHealth | null = null;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function parseCXLongImageCaptureResult(raw: unknown): CXLongImageCaptureResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 40
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  const png = value.png instanceof Uint8Array ? value.png : value.png instanceof ArrayBuffer ? new Uint8Array(value.png) : null;
  if (!isUuid(value.buildId) || typeof value.sourceHash !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sourceHash)
    || !png || png.byteLength < 24 || png.byteLength > 64 * 1024 * 1024
    || value.width !== 780 || !Number.isSafeInteger(value.height) || (value.height as number) < 1 || (value.height as number) > 60_000
    || !Number.isSafeInteger(value.heightCss) || (value.heightCss as number) < 1 || (value.heightCss as number) > 30_000
    || value.dpr !== 2 || value.viewportWidth !== 390 || value.viewportHeight !== 844
    || !Number.isSafeInteger(value.segments) || (value.segments as number) < 1 || (value.segments as number) > 8
    || value.captureEngine !== 'chromium-cdp' || typeof value.captureEngineVersion !== 'string' || value.captureEngineVersion.length > 128
    || typeof value.captureCheckScope !== 'string' || value.captureCheckScope.length > 256
    || typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))
    || typeof value.fontFamily !== 'string' || value.fontFamily.length > 256) return null;
  return {
    ok: true,
    buildId: value.buildId,
    sourceHash: value.sourceHash,
    png,
    width: value.width,
    height: value.height as number,
    heightCss: value.heightCss as number,
    dpr: value.dpr,
    viewportWidth: value.viewportWidth,
    viewportHeight: value.viewportHeight,
    segments: value.segments as number,
    captureEngine: value.captureEngine,
    captureEngineVersion: value.captureEngineVersion,
    captureCheckScope: value.captureCheckScope,
    capturedAt: value.capturedAt,
    fontFamily: value.fontFamily
  };
}

function parseComputerWindowListResult(raw: unknown): ComputerWindowListResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 60
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  if (!Array.isArray(value.windows) || value.windows.length > 200) return null;
  const windows: ComputerWindowView[] = [];
  for (const item of value.windows) {
    const win = asRecord(item);
    if (!win || typeof win.handle !== 'string' || !/^[0-9a-f]{32}$/.test(win.handle)) return null;
    // DEV-CU P5-2（用户选定方案①）：窗口列表补 pid——观察/动作意图必填 pid，而 handle 是不可逆
    // 摘要无法反解。pid 只在本机渲染器↔主进程之间流动，不进服务端、不进模型上下文；
    // C09 仍禁 process_path / hwnd / class_name / 完整标题全集，越界字段不进构造结果。
    if (!Number.isInteger(win.pid) || (win.pid as number) <= 0) return null;
    if (typeof win.process !== 'string' || win.process.length > 120) return null;
    if (typeof win.title !== 'string' || win.title.length > 256) return null;
    if (typeof win.forbidden !== 'boolean') return null;
    windows.push({ pid: win.pid as number, handle: win.handle, process: win.process, title: win.title, forbidden: win.forbidden });
  }
  return { ok: true, windows };
}

// DT-04：UIA 读取结果白名单。worker 失败时返回 {ok:false,error}，映射为 code 透出。
function parseComputerUiaViewResult(raw: unknown): ComputerUiaViewResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.error === 'string' && value.error.length <= 60
      ? { ok: false, code: value.error, message: 'UIA 读取失败。' }
      : null;
  }
  if (typeof value.window !== 'string' || value.window.length > 256) return null;
  if (!Array.isArray(value.controls) || value.controls.length > 200) return null;
  const controls: ComputerUiaControl[] = [];
  for (const item of value.controls) {
    const c = asRecord(item);
    if (!c) return null;
    // C09：逐控件四键白名单——进程路径/句柄/类名等越界字段整批拒绝。
    if (Object.keys(c).sort().join(',') !== 'id,name,type,value') return null;
    if (typeof c.id !== 'string' || c.id.length > 200) return null;
    if (typeof c.type !== 'string' || c.type.length > 60) return null;
    if (typeof c.name !== 'string' || c.name.length > 500) return null;
    if (typeof c.value !== 'string' || c.value.length > 4000) return null;
    controls.push({ id: c.id, type: c.type, name: c.name, value: c.value });
  }
  return { ok: true, window: value.window, controls };
}

// DT-04：UIA 单控件动作结果白名单。
function parseComputerUiaInvokeResult(raw: unknown): ComputerUiaInvokeResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.error === 'string' && value.error.length <= 60
      ? { ok: false, code: value.error, message: 'UIA 动作失败。' }
      : null;
  }
  return typeof value.action === 'string' && ['invoke', 'setvalue'].includes(value.action)
    ? { ok: true, action: value.action }
    : null;
}

// DEV-CU P3-7（步骤 2/3）：observe 节点递归校验。键集合整批拒绝；
// 长度上限逐项：name <=500、value <=4000、ref <=64、树深 <=50。
const COMPUTER_OBSERVE_NODE_KEYS = 'available_actions,bounds,children,children_count,depth,name,ref_id,role,states,value';
const COMPUTER_OBSERVE_ACTIONS = new Set([
  'Click', 'DoubleClick', 'RightClick', 'TripleClick', 'Hover', 'Drag', 'SetValue',
  'TypeText', 'Clear', 'Select', 'Expand', 'Collapse', 'Toggle', 'Check', 'Uncheck',
  'Scroll', 'ScrollTo', 'SetFocus', 'Observe',
]);
const COMPUTER_OBSERVE_STATES = new Set([
  'enabled', 'disabled', 'visible', 'offscreen', 'checked', 'unchecked',
  'indeterminate', 'expanded', 'collapsed', 'secure', 'focused', 'selected',
]);

// §4.12 控件上限 200：树形态下以「节点总数」落点（worker 侧节点上限同为 200）。
const COMPUTER_OBSERVE_NODE_LIMIT = 200;

type ObserveCounter = { nodes: number };

function parseComputerObserveNode(raw: unknown, depth: number, counter: ObserveCounter): ComputerUiaObserveNode | null {
  if (depth > 50) return null;
  counter.nodes += 1;
  if (counter.nodes > COMPUTER_OBSERVE_NODE_LIMIT) return null;
  const node = asRecord(raw);
  if (!node) return null;
  if (Object.keys(node).sort().join(',') !== COMPUTER_OBSERVE_NODE_KEYS) return null;
  if (typeof node.role !== 'string' || node.role.length === 0 || node.role.length > 40) return null;
  if (typeof node.name !== 'string' || node.name.length > 500) return null;
  if (typeof node.value !== 'string' || node.value.length > 4000) return null;
  if (typeof node.ref_id !== 'string' || node.ref_id.length > 64) return null;
  if (!Array.isArray(node.available_actions)) return null;
  const actions: string[] = [];
  for (const a of node.available_actions) {
    if (typeof a !== 'string' || !COMPUTER_OBSERVE_ACTIONS.has(a)) return null;
    actions.push(a);
  }
  if (!Array.isArray(node.states)) return null;
  const states: string[] = [];
  for (const st of node.states) {
    if (typeof st !== 'string' || !COMPUTER_OBSERVE_STATES.has(st)) return null;
    states.push(st);
  }
  const b = asRecord(node.bounds);
  if (!b) return null;
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!Number.isFinite(b[k])) return null;
  }
  const childrenCount = node.children_count;
  const nodeDepth = node.depth;
  if (typeof childrenCount !== 'number' || !Number.isInteger(childrenCount) || childrenCount < 0) return null;
  if (typeof nodeDepth !== 'number' || !Number.isInteger(nodeDepth) || nodeDepth < 0) return null;
  if (!Array.isArray(node.children)) return null;
  const children: ComputerUiaObserveNode[] = [];
  for (const child of node.children) {
    const parsed = parseComputerObserveNode(child, depth + 1, counter);
    if (!parsed) return null;
    children.push(parsed);
  }
  return {
    role: node.role, name: node.name, value: node.value, ref_id: node.ref_id,
    available_actions: actions, states,
    bounds: { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) },
    children, children_count: childrenCount, depth: nodeDepth,
  };
}

function parseComputerUiaObserveResult(raw: unknown): ComputerUiaObserveResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.error === 'string' && value.error.length <= 60
      ? { ok: false, code: value.error, message: 'UIA 观察失败。' }
      : null;
  }
  if (typeof value.snapshot_id !== 'string' || value.snapshot_id.length === 0 || value.snapshot_id.length > 64) return null;
  const revision = value.revision;
  const refCount = value.ref_count;
  const nodesObserved = value.nodes_observed;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  if (typeof refCount !== 'number' || !Number.isInteger(refCount) || refCount < 0) return null;
  if (typeof value.complete !== 'boolean') return null;
  if (typeof nodesObserved !== 'number' || !Number.isInteger(nodesObserved) || nodesObserved < 0) return null;
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') return null;
  if (value.identity_unproven !== undefined && typeof value.identity_unproven !== 'boolean') return null;
  const tree = parseComputerObserveNode(value.tree, 0, { nodes: 0 });
  if (!tree) return null;
  const result: ComputerUiaObserveResult = {
    ok: true, snapshot_id: value.snapshot_id, revision,
    ref_count: refCount, complete: value.complete, nodes_observed: nodesObserved,
    tree,
  };
  if (value.truncated === true) result.truncated = true;
  if (value.identity_unproven === true) result.identity_unproven = true;
  return result;
}

const COMPUTER_ACT_DELIVERY_RETRY: Record<string, string> = {
  not_delivered: 'safe', delivery_uncertain: 'unsafe', delivered_unverified: 'unsafe',
  delivered_verified: 'unsafe', unknown: 'unknown',
};
function parseComputerUiaActResult(raw: unknown): ComputerUiaActResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.error === 'string' && value.error.length <= 60
      ? { ok: false, code: value.error, message: 'UIA 动作失败。' }
      : null;
  }
  if (typeof value.action !== 'string' || value.action.length === 0 || value.action.length > 32) return null;
  const disp = asRecord(value.disposition);
  if (!disp) return null;
  const delivery = typeof disp.delivery === 'string' ? disp.delivery : '';
  const retry = typeof disp.retry === 'string' ? disp.retry : '';
  if (!delivery || COMPUTER_ACT_DELIVERY_RETRY[delivery] !== retry) return null;
  const result: ComputerUiaActResult = {
    ok: true, action: value.action, disposition: { delivery, retry },
  };
  if (value.snapshot_id !== undefined) {
    if (typeof value.snapshot_id !== 'string' || value.snapshot_id.length > 64) return null;
    result.snapshot_id = value.snapshot_id;
  }
  if (value.ref !== undefined) {
    if (typeof value.ref !== 'string' || value.ref.length > 64) return null;
    result.ref = value.ref;
  }
  if (value.verification_scope !== undefined) {
    if (typeof value.verification_scope !== 'string' || value.verification_scope.length > 32) return null;
    result.verification_scope = value.verification_scope;
  }
  if (value.verification_reason !== undefined) {
    if (typeof value.verification_reason !== 'string' || value.verification_reason.length > 64) return null;
    result.verification_reason = value.verification_reason;
  }
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > 20) return null;
    const steps: Array<{ label: string; outcome: string; mechanism: string }> = [];
    for (const step of value.steps) {
      const st = asRecord(step);
      if (!st || typeof st.label !== 'string' || st.label.length === 0 || st.label.length > 80
        || typeof st.outcome !== 'string' || st.outcome.length > 24
        || typeof st.mechanism !== 'string' || st.mechanism !== 'semantic_api') return null;
      steps.push({ label: st.label, outcome: st.outcome, mechanism: st.mechanism });
    }
    result.steps = steps;
  }
  return result;
}

function parseComputerUiaInvalidateResult(raw: unknown): ComputerUiaInvalidateResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.error === 'string' && value.error.length <= 60
      ? { ok: false, code: value.error, message: '撤销失败。' }
      : null;
  }
  const cleared = value.cleared;
  if (typeof cleared !== 'number' || !Number.isInteger(cleared) || cleared < 0) return null;
  return { ok: true, cleared };
}

function parseBrowserTabListResult(raw: unknown): BrowserTabListResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 60
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  if (!Array.isArray(value.tabs) || value.tabs.length > 200) return null;
  const tabs: BrowserTabView[] = [];
  for (const item of value.tabs) {
    const tab = asRecord(item);
    if (!tab || typeof tab.tab_id !== 'number' || !Number.isSafeInteger(tab.tab_id)) return null;
    if (typeof tab.title !== 'string' || tab.title.length > 120) return null;
    if (typeof tab.origin !== 'string' || tab.origin.length > 200) return null;
    if (typeof tab.window_id !== 'number' || !Number.isSafeInteger(tab.window_id)) return null;
    if (typeof tab.active !== 'boolean') return null;
    tabs.push({ tab_id: tab.tab_id, title: tab.title, origin: tab.origin, window_id: tab.window_id, active: tab.active });
  }
  return { ok: true, tabs };
}

function parseBrowserPairingStateResult(raw: unknown): BrowserPairingStateResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 60
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  const snap = asRecord(value.snapshot);
  if (!snap) return null;
  // 白名单键集合断言：任何多余键（如 session_key/hkdf_salt/hmac）整份拒绝。
  if (Object.keys(snap).sort().join(',') !== 'extension_instance_id,host_pid,pairing,state') return null;
  if (!['unpaired', 'pairing', 'paired', 'revoked'].includes(String(snap.state))) return null;
  if (snap.extension_instance_id !== null
    && (typeof snap.extension_instance_id !== 'string' || snap.extension_instance_id.length > 64)) return null;
  if (snap.host_pid !== null && (typeof snap.host_pid !== 'number' || !Number.isSafeInteger(snap.host_pid))) return null;
  let pairing: BrowserPairingSnapshot['pairing'] = null;
  if (snap.pairing !== null) {
    const p = asRecord(snap.pairing);
    if (!p) return null;
    if (Object.keys(p).sort().join(',') !== 'code,expired,expires_at') return null;
    // 桥生成短码固定 6 位数字（crypto.randomInt + padStart）；形态不符即拒绝。
    if (typeof p.code !== 'string' || !/^[0-9]{6}$/.test(p.code)) return null;
    if (typeof p.expires_at !== 'number' || !Number.isSafeInteger(p.expires_at)) return null;
    if (typeof p.expired !== 'boolean') return null;
    pairing = { code: p.code, expires_at: p.expires_at, expired: p.expired };
  }
  return {
    ok: true,
    snapshot: {
      state: snap.state as BrowserPairingSnapshot['state'],
      pairing,
      extension_instance_id: snap.extension_instance_id as string | null,
      host_pid: snap.host_pid as number | null,
    },
  };
}

function parseBrowserPairingConfirmResult(raw: unknown): BrowserPairingConfirmResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 60
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  if (Object.keys(value).sort().join(',') !== 'extension_instance_id,ok') return null;
  if (value.extension_instance_id !== null
    && (typeof value.extension_instance_id !== 'string' || value.extension_instance_id.length > 64)) return null;
  return { ok: true, extension_instance_id: value.extension_instance_id as string | null };
}

function parseMcpValidateResult(raw: unknown): McpValidateResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 40
      && typeof value.message === 'string' && value.message.length <= 300
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  const catalog = asRecord(value.catalog);
  if (!catalog) return null;
  const server = asRecord(catalog.server_info);
  if (!server || typeof server.name !== 'string' || typeof server.version !== 'string'
    || typeof server.protocol_version !== 'string') return null;
  if (!Array.isArray(catalog.tools) || catalog.tools.length > 500) return null;
  const tools: McpToolDescriptorView[] = [];
  for (const item of catalog.tools) {
    const tool = asRecord(item);
    if (!tool || typeof tool.name !== 'string' || tool.name.length > 200) return null;
    if (typeof tool.description_hash !== 'string' || !/^[0-9a-f]{16}$/.test(tool.description_hash)) return null;
    if (typeof tool.input_schema !== 'object' || tool.input_schema === null) return null;
    tools.push({ name: tool.name, description_hash: tool.description_hash, input_schema: tool.input_schema, ...(tool.output_schema !== undefined ? { output_schema: tool.output_schema } : {}) });
  }
  if (typeof catalog.catalog_revision !== 'string' || catalog.catalog_revision.length > 64) return null;
  return { ok: true, catalog: { tools, server_info: { name: server.name, version: server.version, protocol_version: server.protocol_version }, catalog_revision: catalog.catalog_revision } };
}

function parseMcpOAuthStatus(raw: unknown): McpOAuthStatus | null {
  const value = asRecord(raw);
  if (!value) return null;
  // 白名单字段：任何多余键（如 access_token/refresh_token）都视为非法——令牌零泄漏断言。
  if (Object.keys(value).sort().join(',') !== 'expires_at,has_refresh,state') return null;
  if (!['unauthorized', 'authorizing', 'authorized', 'needs_reauth'].includes(String(value.state))) return null;
  if (value.expires_at !== null && (typeof value.expires_at !== 'string' || value.expires_at.length > 40 || Number.isNaN(Date.parse(value.expires_at)))) return null;
  if (typeof value.has_refresh !== 'boolean') return null;
  return { state: value.state as McpOAuthStatus['state'], expires_at: value.expires_at as string | null, has_refresh: value.has_refresh };
}

function parseMcpOAuthStartResult(raw: unknown): McpOAuthStartResult | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'ok,reason,state') return null;
  if (typeof value.ok !== 'boolean' || typeof value.state !== 'string' || typeof value.reason !== 'string' || value.reason.length > 200) return null;
  return { ok: value.ok, state: value.state, reason: value.reason };
}

function parsePlatformIntentResult(raw: unknown): PlatformIntentResult | null {  const value = asRecord(raw);
  if (!value || !isUuid(value.requestId) || !isUuid(value.accountId)) return null;
  if (!['platform-account-sync', 'platform-metrics-refresh', 'platform-sync-resume'].includes(String(value.kind))) return null;
  if (!['queued', 'existing', 'no_targets', 'failed'].includes(String(value.status))) return null;
  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 200)) return null;
  if (value.operationId !== undefined && !isUuid(value.operationId)) return null;

  const kind = value.kind as PlatformIntentResult['kind'];
  const status = value.status as PlatformIntentResult['status'];
  if (kind === 'platform-sync-resume' && (status !== 'queued' && status !== 'failed' || !isUuid(value.operationId))) return null;

  return {
    kind,
    requestId: value.requestId,
    accountId: value.accountId,
    status,
    ...(isUuid(value.operationId) ? { operationId: value.operationId } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {})
  };
}

function parseClientHealth(raw: unknown): DesktopClientHealth | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'channelMessage,channelState,collection,presence') return null;
  if (!['disconnected', 'connecting', 'ready', 'error'].includes(String(value.channelState))
    || typeof value.channelMessage !== 'string' || value.channelMessage.length > 200) return null;
  const collection = asRecord(value.collection);
  const presence = asRecord(value.presence);
  if (!collection || Object.keys(collection).sort().join(',') !== 'message,status,updatedAt'
    || !['idle', 'running', 'partial', 'failed'].includes(String(collection.status))
    || typeof collection.message !== 'string' || collection.message.length > 200
    || !(collection.updatedAt === null || (typeof collection.updatedAt === 'number' && Number.isSafeInteger(collection.updatedAt) && collection.updatedAt >= 0))) return null;
  if (!presence || Object.keys(presence).sort().join(',') !== 'message,status,updatedAt'
    || !['unknown', 'online', 'offline', 'error'].includes(String(presence.status))
    || typeof presence.message !== 'string' || presence.message.length > 200
    || !(presence.updatedAt === null || (typeof presence.updatedAt === 'number' && Number.isSafeInteger(presence.updatedAt) && presence.updatedAt >= 0))) return null;
  return {
    channelState: value.channelState as DesktopClientHealth['channelState'],
    channelMessage: value.channelMessage,
    collection: {
      status: collection.status as DesktopClientHealth['collection']['status'],
      message: collection.message,
      updatedAt: collection.updatedAt as number | null
    },
    presence: {
      status: presence.status as DesktopClientHealth['presence']['status'],
      message: presence.message,
      updatedAt: presence.updatedAt as number | null
    }
  };
}

ipcRenderer.on(OPEN_SETTINGS_CHANNEL, () => {
  if (openSettingsListeners.size === 0) {
    pendingOpenSettings = true;
    return;
  }
  for (const listener of openSettingsListeners) listener();
});

ipcRenderer.on(LOCAL_SETTINGS_STATE_CHANNEL, (_event: IpcRendererEvent, state: LocalSettingsState) => {
  if (!state || typeof state.dirty !== 'boolean' || typeof state.busy !== 'boolean') return;
  latestLocalSettingsState = { dirty: state.dirty, busy: state.busy };
  for (const listener of localSettingsStateListeners) listener(latestLocalSettingsState);
});

ipcRenderer.on(PLATFORM_INTENT_RESULT_CHANNEL, (_event: IpcRendererEvent, raw: unknown) => {
  const result = parsePlatformIntentResult(raw);
  if (!result) return;
  for (const listener of platformIntentResultListeners) listener(result);
});

ipcRenderer.on(CLIENT_HEALTH_CHANNEL, (_event: IpcRendererEvent, raw: unknown) => {
  const health = parseClientHealth(raw);
  if (!health) return;
  latestClientHealth = health;
  for (const listener of clientHealthListeners) listener(health);
});

contextBridge.exposeInMainWorld('opsDesktopUI', {
  onOpenSettings(listener: SettingsOpenListener) {
    openSettingsListeners.add(listener);
    if (pendingOpenSettings) {
      pendingOpenSettings = false;
      listener();
    }
    return () => openSettingsListeners.delete(listener);
  },
  onLocalSettingsState(listener: LocalSettingsStateListener) {
    localSettingsStateListeners.add(listener);
    if (latestLocalSettingsState) listener(latestLocalSettingsState);
    return () => localSettingsStateListeners.delete(listener);
  },
  onPlatformIntentResult(listener: PlatformIntentResultListener) {
    platformIntentResultListeners.add(listener);
    return () => platformIntentResultListeners.delete(listener);
  },
  onClientHealth(listener: ClientHealthListener) {
    clientHealthListeners.add(listener);
    if (latestClientHealth) listener(latestClientHealth);
    return () => clientHealthListeners.delete(listener);
  },
  async captureLongImage(buildId: string): Promise<CXLongImageCaptureResult> {
    if (!isUuid(buildId)) return { ok: false, code: 'invalid_input', message: '长图构建参数无效。' };
    const result = parseCXLongImageCaptureResult(await ipcRenderer.invoke(CX_LONG_IMAGE_CAPTURE_CHANNEL, { buildId }));
    return result ?? { ok: false, code: 'long_image_invalid', message: 'Electron 返回的长图结果无效。' };
  },
  // DEV-AI27-17（W17b，A12）：本机窗口枚举——只在本机执行，渲染器拿到的是不透明 handle。
  async listComputerWindows(): Promise<ComputerWindowListResult> {
    const result = parseComputerWindowListResult(await ipcRenderer.invoke('computer:list-windows'));
    return result ?? { ok: false, code: 'computer_windows_invalid', message: 'Electron 返回的窗口列表无效。' };
  },
  // DT-04（W17c）：UIA 主链路固定意图——参数本机校验后转发主进程；结果按
  // C09 白名单逐项校验，越界字段整批拒绝，进程路径/截图不进渲染器。
  async readComputerUIA(input: { pid: number; target_summary: string }): Promise<ComputerUiaViewResult> {
    if (!Number.isInteger(input?.pid) || (input as { pid: number }).pid <= 0
      || typeof input?.target_summary !== 'string') {
      return { ok: false, code: 'computer_uia_invalid', message: 'UIA 参数无效。' };
    }
    const result = parseComputerUiaViewResult(await ipcRenderer.invoke('computer:uia-read', { pid: input.pid, target_summary: input.target_summary.slice(0, 256) }));
    return result ?? { ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 读取结果无效。' };
  },
  async invokeComputerUIA(input: { pid: number; automation_id: string; value?: string | null; target_summary: string }): Promise<ComputerUiaInvokeResult> {
    if (!Number.isInteger(input?.pid) || (input as { pid: number }).pid <= 0
      || typeof input?.automation_id !== 'string' || input.automation_id.length === 0 || input.automation_id.length > 200
      || typeof input?.target_summary !== 'string') {
      return { ok: false, code: 'computer_uia_invalid', message: 'UIA 参数无效。' };
    }
    const value = input.value === undefined || input.value === null ? null : String(input.value).slice(0, 32768);
    const result = parseComputerUiaInvokeResult(await ipcRenderer.invoke('computer:uia-invoke', { pid: input.pid, automation_id: input.automation_id, value, target_summary: input.target_summary.slice(0, 256) }));
    return result ?? { ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 动作结果无效。' };
  },
  // DEV-CU P3-7（步骤 4）：observe/act/invalidate 三个固定意图——参数本机校验后
  // 转发主进程；observe 结果按 §4.12 白名单递归校验（native_id 等内部字段不可枚举，
  // 出现即整批拒绝），act 结果校验 disposition 双字段一致性。
  async observeComputerUIA(input: { pid: number; target_summary: string; grant_id: string; generation: number; max_depth?: number; root_ref?: string; interactive_only?: boolean; compact?: boolean }): Promise<ComputerUiaObserveResult> {
    if (!Number.isInteger(input?.pid) || (input as { pid: number }).pid <= 0
      || typeof input?.target_summary !== 'string'
      || typeof input?.grant_id !== 'string' || input.grant_id.length === 0 || input.grant_id.length > 64
      || !Number.isInteger(input?.generation) || input.generation < 0) {
      return { ok: false, code: 'computer_uia_invalid', message: 'UIA 观察参数无效。' };
    }
    const payload: Record<string, unknown> = {
      pid: input.pid, target_summary: input.target_summary.slice(0, 256),
      grant_id: input.grant_id, generation: input.generation,
    };
    if (input.max_depth !== undefined) {
      if (!Number.isInteger(input.max_depth) || input.max_depth < 0 || input.max_depth > 50) {
        return { ok: false, code: 'computer_uia_invalid', message: 'UIA 观察参数无效。' };
      }
      payload.max_depth = input.max_depth;
    }
    if (input.root_ref !== undefined) {
      if (typeof input.root_ref !== 'string' || input.root_ref.length > 64) {
        return { ok: false, code: 'computer_uia_invalid', message: 'UIA 观察参数无效。' };
      }
      payload.root_ref = input.root_ref;
    }
    if (input.interactive_only !== undefined) payload.interactive_only = input.interactive_only === true;
    if (input.compact !== undefined) payload.compact = input.compact === true;
    const result = parseComputerUiaObserveResult(await ipcRenderer.invoke('computer:uia-observe', payload));
    return result ?? { ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 观察结果无效。' };
  },
  async actComputerUIA(input: { pid: number; ref: string; grant_id: string; generation: number; action: string; value?: string | null; target_summary: string }): Promise<ComputerUiaActResult> {
    if (!Number.isInteger(input?.pid) || (input as { pid: number }).pid <= 0
      || typeof input?.ref !== 'string' || !/^@[A-Za-z0-9_-]{3,64}:e[1-9][0-9]{0,9}$/.test(input.ref)
      || typeof input?.grant_id !== 'string' || input.grant_id.length === 0 || input.grant_id.length > 64
      || !Number.isInteger(input?.generation) || input.generation < 0
      || typeof input?.action !== 'string' || input.action.length === 0 || input.action.length > 32
      || typeof input?.target_summary !== 'string') {
      return { ok: false, code: 'computer_uia_invalid', message: 'UIA 动作参数无效。' };
    }
    const value = input.value === undefined || input.value === null ? null : String(input.value).slice(0, 32768);
    const result = parseComputerUiaActResult(await ipcRenderer.invoke('computer:uia-act', {
      pid: input.pid, ref: input.ref, grant_id: input.grant_id, generation: input.generation,
      action: input.action, value, target_summary: input.target_summary.slice(0, 256),
    }));
    return result ?? { ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 动作结果无效。' };
  },
  async invalidateComputerUIA(grantId: string): Promise<ComputerUiaInvalidateResult> {
    if (typeof grantId !== 'string' || grantId.length === 0 || grantId.length > 64) {
      return { ok: false, code: 'computer_uia_invalid', message: '撤销参数无效。' };
    }
    const result = parseComputerUiaInvalidateResult(await ipcRenderer.invoke('computer:uia-invalidate', { grant_id: grantId }));
    return result ?? { ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的撤销结果无效。' };
  },
  // DEV-AI27-A30：本机标签枚举（选标签授权弹窗）——枚举在本机，桥未启动/未配对时如实报错。
  async listBrowserTabs(): Promise<BrowserTabListResult> {
    const result = parseBrowserTabListResult(await ipcRenderer.invoke('browser:list-tabs'));
    return result ?? { ok: false, code: 'browser_tabs_invalid', message: 'Electron 返回的标签列表无效。' };
  },
  // DEV-AI27-A30b：配对统一——读桥侧配对快照 / 确认桥侧配对（一次动作两产物的本机一半；
  // 服务端绑定由渲染器持扩展实例 ID 自行调用服务端 API 完成）。
  async getBrowserPairingState(): Promise<BrowserPairingStateResult> {
    const result = parseBrowserPairingStateResult(await ipcRenderer.invoke('browser:pairing-state'));
    return result ?? { ok: false, code: 'browser_pairing_state_invalid', message: 'Electron 返回的配对状态无效。' };
  },
  async confirmBrowserPairing(): Promise<BrowserPairingConfirmResult> {
    const result = parseBrowserPairingConfirmResult(await ipcRenderer.invoke('browser:confirm-pairing'));
    return result ?? { ok: false, code: 'browser_pairing_confirm_invalid', message: 'Electron 返回的配对确认结果无效。' };
  },
  // DEV-AI27-A3 第一片：MCP 验证——真实握手后返回目录；失败原样透出（不伪造已验证）。
  async validateMcpConnection(input: McpValidateInput): Promise<McpValidateResult> {
    const result = parseMcpValidateResult(await ipcRenderer.invoke('mcp:validate', input));
    return result ?? { ok: false, code: 'mcp_validate_invalid', message: 'Electron 返回的验证结果无效。' };
  },
  // DEV-AI27-A3 第二片：OAuth 授权生命周期——start 走系统浏览器（阻塞至完成/超时），
  // status/revoke 只返回状态摘要，令牌明文不出 IPC。
  async startMcpOAuth(input: { connection_id: string; server_url: string; client_id?: string; scopes?: string[] }): Promise<McpOAuthStartResult> {
    const result = parseMcpOAuthStartResult(await ipcRenderer.invoke('mcp:oauth-start', input));
    return result ?? { ok: false, state: 'needs_reauth', reason: 'Electron 返回的授权结果无效。' };
  },
  async getMcpOAuthStatus(input: { connection_id: string; server_url: string; client_id?: string; scopes?: string[] }): Promise<McpOAuthStatus> {
    const result = parseMcpOAuthStatus(await ipcRenderer.invoke('mcp:oauth-status', input));
    return result ?? { state: 'unauthorized', expires_at: null, has_refresh: false };
  },
  async revokeMcpOAuth(input: { connection_id: string; server_url: string; client_id?: string; scopes?: string[] }): Promise<{ ok: boolean }> {
    const value = asRecord(await ipcRenderer.invoke('mcp:oauth-revoke', input));
    return value && value.ok === true ? { ok: true } : { ok: false };
  },
  // DEV-AI27-08（W08）：内置浏览视图固定意图（白名单通道；渲染器无 view 对象）。
  async invokeInBrowse(channel: string, payload?: unknown): Promise<unknown> {
    const allowed = ['inbrowse:snapshot', 'inbrowse:set-bounds', 'inbrowse:navigate', 'inbrowse:back', 'inbrowse:forward', 'inbrowse:reload', 'inbrowse:stop', 'inbrowse:close', 'inbrowse:open-tab', 'inbrowse:switch-tab', 'inbrowse:close-tab', 'inbrowse:reorder-tab', 'inbrowse:data-stats', 'inbrowse:clear-data', 'voice:realtime-status', 'voice:realtime-start', 'voice:realtime-append', 'voice:realtime-commit', 'voice:realtime-interrupt', 'voice:realtime-stop'];
    if (!allowed.includes(channel)) throw new Error(`不允许的内置浏览意图：${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  onInBrowseSnapshot(listener: (snapshot: unknown) => void) {
    const wrapped = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on('desktop-ui:inbrowse-snapshot', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:inbrowse-snapshot', wrapped); };
  },
  // DEV-AI27-16 第六批（A2）：realtime 桥事件（audio_delta/transcript_delta/error 等信封）。
  onRealtimeEvent(listener: (event: unknown) => void) {
    const wrapped = (_event: unknown, ev: unknown) => listener(ev);
    ipcRenderer.on('desktop-ui:realtime-event', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:realtime-event', wrapped); };
  },
  // DEV-AI27-10（W10b）：侧栏草稿/停止事件（主进程桥转发）。
  onSidepanelDraft(listener: (draft: { text: string }) => void) {
    const wrapped = (_event: unknown, draft: unknown) => listener(draft as { text: string });
    ipcRenderer.on('desktop-ui:sidepanel-draft', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:sidepanel-draft', wrapped); };
  },
  onSidepanelStop(listener: () => void) {
    const wrapped = () => listener();
    ipcRenderer.on('desktop-ui:sidepanel-stop', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:sidepanel-stop', wrapped); };
  }
});
