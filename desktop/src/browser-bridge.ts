import { BrowserWindow, ipcMain } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

// DEV-AI27-02 W02 技术验证：OPS 桌面浏览器桥。
// 回环 TCP(8765, NDJSON) <-> native-host <-> Chrome 扩展。
// 配对（短码人工核对）→ HMAC 会话 → 登记动作派发 → 命令账本（幂等/超时 unknown_outcome）。
// A30b（用户拍板：常驻启动）：产品路径由 main.ts 经 ensureProductBridge 启动并常驻；
// 端口被占等启动失败时如实降级（不崩溃）。诊断模式（DIAG=1）复用同一实例只补开诊断窗。

export const PROTOCOL_VERSION = 1;
// A14-6（27 §14）：信封加密版本。v1 = 会话根密钥直接作 HMAC 密钥；v2 = 按配对随机 salt
// 用 HKDF-SHA256 派生用途限定子密钥。两版共存，按 hello 声明的能力协商，旧扩展仍走 v1。
export const CRYPTO_VERSION_V1 = 1;
export const CRYPTO_VERSION_V2 = 2;
export const SUPPORTED_CRYPTO_VERSIONS = [CRYPTO_VERSION_V1, CRYPTO_VERSION_V2];
const HKDF_INFO = 'ops-browser-bridge/v2/hmac';
export const BRIDGE_PORT = 8765;
export const CONTROL_PORT = 8766;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_ACTION_TIMEOUT_MS = 30 * 1000;
const MAX_LINE = 4 * 1024 * 1024;

export type BridgeState = 'unpaired' | 'pairing' | 'paired' | 'revoked';
export type LedgerState = 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled' | 'unknown_outcome';
const TRUSTED_TYPES = new Set([
  'hello',
  'pairing_start',
  'pairing_confirm',
  'pairing_confirmed',
  'result',
  'revoke',
  'ping',
  'pong',
  'error',
]);

export interface BridgeEnvelope {
  v: number;
  type: string;
  request_id?: string;
  generation?: number;
  issued_at?: number;
  deadline_at?: number;
  nonce?: string;
  action?: string;
  payload?: unknown;
  payload_hash?: string;
  seq?: number;
  hmac?: string;
}

export interface LedgerEntry {
  request_id: string;
  action: string;
  input_hash: string;
  state: LedgerState;
  created_at: number;
  dispatched_at?: number;
  deadline_at?: number;
  result?: unknown;
  error_code?: string;
}

// 27 §13.5/§15.1：元数据信封建议上限 256KiB，图片/大文本走分块/附件通道（W09），不在命令体内。
export const MAX_METADATA_BYTES = 256 * 1024;
// 27 §15.1：登记动作集；桥侧前置白名单，扩展侧登记表为第二道校验。
export const ALLOWED_ACTIONS = new Set(['tabs_list', 'observe', 'observe_frames', 'navigate', 'click', 'type', 'extract', 'screenshot']);
// 27 §13.5：时钟异常停止派发（wall clock 与单调时钟漂移超限即拒绝，直至恢复）。
const CLOCK_TOLERANCE_MS = 5000;

// 稳定错误码（对齐 27 §13.7 的本机子集）。
export type BridgeErrorCode =
  | 'browser_not_paired'
  | 'browser_action_unsupported'
  | 'browser_payload_limit'
  | 'browser_clock_unstable'
  | 'browser_request_conflict';

// A14-5（27 §14）：信封 HMAC 材料扩展到 seq.type.nonce.payload_hash.payload——
// 只覆盖 seq+type+payload 无法绑定「这次派发」的 nonce 与载荷摘要，重放窗口更宽。
// 与旧格式不兼容：会话密钥每次配对重新生成（pairing_confirm 新 key），无跨代负担；
// result 信封带 nonce/payload_hash，其余类型两参为空串。
function hmacSign(key: Buffer, seq: number, type: string, payload: unknown, nonce = '', payloadHash = ''): string {
  return crypto.createHmac('sha256', key)
    .update(`${seq}.${type}.${nonce}.${payloadHash}.${JSON.stringify(payload ?? null)}`)
    .digest('base64');
}

// A14-6：v2 的 HMAC 密钥 = HKDF-SHA256(ikm=会话根密钥, salt=本次配对随机盐, info=用途)。
// 根密钥只参与派生、不再直接进入签名路径；同一配对的 salt 由桥生成并随 pairing_confirm 下发。
export function deriveMessageKey(sessionKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', sessionKey, salt, HKDF_INFO, 32));
}

function verifyHmac(key: Buffer, seq: number, type: string, payload: unknown, got: string, nonce = '', payloadHash = ''): boolean {
  const expect = Buffer.from(hmacSign(key, seq, type, payload, nonce, payloadHash));
  const actual = Buffer.from(got);
  return expect.length === actual.length && crypto.timingSafeEqual(expect, actual);
}

function inputHash(action: string, payload: unknown): string {
  return crypto.createHash('sha256').update(`${action}.${JSON.stringify(payload ?? null)}`).digest('hex');
}

/** 命令账本：request_id 幂等、状态单向推进、JSON 文件持久化。 */
export class CommandLedger {
  private entries = new Map<string, LedgerEntry>();

  constructor(private readonly filePath: string | null) {
    if (filePath) this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath as string, 'utf8')) as LedgerEntry[];
      for (const e of raw) this.entries.set(e.request_id, e);
    } catch {
      /* 首次无账本 */
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${this.filePath}.tmp`, JSON.stringify([...this.entries.values()]));
      fs.renameSync(`${this.filePath}.tmp`, this.filePath);
    } catch {
      /* 持久化失败不阻断内存账本 */
    }
  }

  /** 同 id 同载荷返回既有条目（幂等）；同 id 异载荷返回冲突。 */
  record(requestId: string, action: string, hash: string, now: number): { entry: LedgerEntry } | { conflict: true } {
    const existing = this.entries.get(requestId);
    if (existing) {
      if (existing.input_hash !== hash) return { conflict: true };
      return { entry: existing };
    }
    const entry: LedgerEntry = { request_id: requestId, action, input_hash: hash, state: 'queued', created_at: now };
    this.entries.set(requestId, entry);
    this.persist();
    return { entry };
  }

  get(requestId: string): LedgerEntry | undefined {
    return this.entries.get(requestId);
  }

  transition(requestId: string, to: LedgerState, patch: Partial<LedgerEntry> = {}): LedgerEntry | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    const allowed: Record<LedgerState, LedgerState[]> = {
      queued: ['dispatched', 'cancelled'],
      dispatched: ['succeeded', 'failed', 'unknown_outcome'],
      succeeded: [],
      failed: [],
      cancelled: [],
      unknown_outcome: [],
    };
    if (!allowed[entry.state].includes(to)) return null;
    entry.state = to;
    Object.assign(entry, patch);
    this.persist();
    return entry;
  }

  /** 超时未回执的 dispatched 条目标记 unknown_outcome（不重放）。 */
  sweepUnknown(now: number): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === 'dispatched' && entry.deadline_at && now > entry.deadline_at + 2000) {
        entry.state = 'unknown_outcome';
        out.push(entry);
      }
    }
    if (out.length) this.persist();
    return out;
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => a.created_at - b.created_at);
  }
}

export interface BridgeEvent {
  kind: 'state' | 'pairing' | 'dispatch' | 'result' | 'revoke' | 'log';
  message: string;
  at: number;
}

export interface BridgeOptions {
  port?: number;
  controlPort?: number | null;
  ledgerPath?: string | null;
  /** A14-2：lastSeqIn 持久化文件（null = 不持久化，测试用）。 */
  seqStatePath?: string | null;
  autoPair?: boolean;
  actionTimeoutMs?: number;
  log?: (line: string) => void;
}

export class BrowserBridge {
  readonly generation = { n: 0 };
  state: BridgeState = 'unpaired';
  pairing: { id: string; code: string; expires_at: number } | null = null;
  hostInfo: { host_instance_id: string; pid: number; connected_at: number } | null = null;
  // A30b：扩展实例 ID（来自扩展 hello 经 native host JSON 透传；配对确认时随
  // pairingSnapshot 交给渲染器组装服务端 binding）。会话密钥绝不在此暴露。
  extensionInstanceId: string | null = null;

  private server: net.Server | null = null;
  private controlServer: http.Server | null = null;
  private socket: net.Socket | null = null;
  private sessionKey: Buffer | null = null;
  // A14-6：v2 协商结果与派生材料；v1 时保持 null（直接使用 sessionKey 签名）。
  private cryptoVersion: number = CRYPTO_VERSION_V1;
  private hkdfSalt: Buffer | null = null;
  private messageKey: Buffer | null = null;
  private seqOut = 0;
  private lastSeqIn = 0;
  private lineBuf = '';
  private events: BridgeEvent[] = [];
  private updateCbs = new Set<() => void>();
  private sweepTimer: NodeJS.Timeout | null = null;
  // 已派发未回执命令的 nonce/哈希（回执防错配/防伪造）。
  private pendingNonce = new Map<string, { nonce: string; payload_hash: string }>();
  // 时钟漂移基线（27 §13.5 时钟异常停止派发）。
  private readonly startWallMs = Date.now();
  private readonly startMonoMs = Number(process.hrtime.bigint() / 1_000_000n);
  private readonly actionTimeoutMs: number;
  private readonly autoPair: boolean;
  private readonly seqStatePath: string | null;
  private readonly log: (line: string) => void;

  /** wall clock 相对单调时钟的漂移毫秒数。 */
  clockDriftMs(): number {
    const monoNow = Number(process.hrtime.bigint() / 1_000_000n);
    const expectedWall = this.startWallMs + (monoNow - this.startMonoMs);
    return Math.abs(Date.now() - expectedWall);
  }

  constructor(
    readonly ledger: CommandLedger,
    private readonly opts: BridgeOptions = {},
  ) {
    this.actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.autoPair = opts.autoPair ?? false;
    this.seqStatePath = opts.seqStatePath ?? null;
    this.log = opts.log ?? (() => {});
  }

  onUpdate(cb: () => void): () => void {
    this.updateCbs.add(cb);
    return () => this.updateCbs.delete(cb);
  }

  emit(kind: BridgeEvent['kind'], message: string): void {
    this.events.push({ kind, message, at: Date.now() });
    this.events = this.events.slice(-200);
    this.log(`[bridge] ${kind}: ${message}`);
    for (const cb of this.updateCbs) cb();
  }

  snapshot() {
    return {
      state: this.state,
      pairing: this.pairing ? { code: this.pairing.code, expires_at: this.pairing.expires_at, expired: Date.now() > this.pairing.expires_at } : null,
      generation: this.generation.n,
      host: this.hostInfo,
      ledger: this.ledger.list().slice(-50),
      events: this.events.slice(-50),
    };
  }

  /** A30b：配对快照（工作台配对向导用）。只含人工核对与组装服务端 confirm 所需字段；
   * 绝不含会话密钥/HKDF 盐/签名材料——preload 白名单校验兜底，这里是源头约束。 */
  pairingSnapshot(): {
    state: BridgeState;
    pairing: { code: string; expires_at: number; expired: boolean } | null;
    extension_instance_id: string | null;
    host_pid: number | null;
  } {
    return {
      state: this.state,
      pairing: this.pairing
        ? { code: this.pairing.code, expires_at: this.pairing.expires_at, expired: Date.now() > this.pairing.expires_at }
        : null,
      extension_instance_id: this.extensionInstanceId,
      host_pid: this.hostInfo?.pid ?? null,
    };
  }

  start(): Promise<void> {
    const port = this.opts.port ?? BRIDGE_PORT;
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.emit('log', `listening on 127.0.0.1:${port}`);
        this.sweepTimer = setInterval(() => this.sweep(), 3000);
        resolve();
      });
    });
  }

  startControl(port: number): Promise<void> {
    const server = http.createServer((req, res) => void this.onControl(req, res));
    this.controlServer = server;
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.emit('log', `verification control on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.controlServer?.close();
    this.socket?.destroy();
    this.socket = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.emit('log', 'bridge stopped');
  }

  private onConnection(socket: net.Socket): void {
    if (socket.remoteAddress !== '127.0.0.1') {
      socket.destroy();
      return;
    }
    if (this.socket && !this.socket.destroyed) {
      this.emit('log', 'reject second host connection');
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    this.emit('log', `host connection accepted peer=${socket.remotePort}`);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.emit('log', `socket error: ${err.message}`));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.emit('state', `host disconnected peer=${socket.remotePort}`);
    });
  }

  private onData(chunk: Buffer): void {
    this.lineBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) {
        this.emit('log', 'line too large; drop');
        continue;
      }
      try {
        this.onEnvelope(JSON.parse(line) as BridgeEnvelope);
      } catch (err) {
        this.emit('log', `bad json from host: ${(err as Error).message}`);
      }
    }
    if (this.lineBuf.length > MAX_LINE) this.lineBuf = '';
  }

  /** A14-6：当前信封签名密钥。v2 用 HKDF 派生的子密钥，v1 直接用会话根密钥。 */
  private signKey(): Buffer | null {
    return this.cryptoVersion === CRYPTO_VERSION_V2 ? this.messageKey : this.sessionKey;
  }

  private checkEnvelope(msg: BridgeEnvelope): string | null {
    if (msg.v !== PROTOCOL_VERSION) return `protocol version mismatch: ${msg.v}`;
    if (!TRUSTED_TYPES.has(msg.type)) return `type not allowed: ${msg.type}`;
    // hello/pairing_start 是配对起点，永远免签；收到即视为重新配对（下方处理时重置会话）。
    const key = this.signKey();
    if (key && msg.type !== 'pairing_start' && msg.type !== 'hello') {
      if (typeof msg.seq !== 'number' || typeof msg.hmac !== 'string') return 'missing seq/hmac';
      // A14-5：签名材料含 nonce/payload_hash（result 信封带值，其余空串）。
      const nonce = typeof msg.nonce === 'string' ? msg.nonce : '';
      const payloadHash = typeof msg.payload_hash === 'string' ? msg.payload_hash : '';
      if (!verifyHmac(key, msg.seq, msg.type, msg.payload, msg.hmac, nonce, payloadHash)) return 'hmac verification failed';
      if (msg.seq <= this.lastSeqIn) return `replayed or out-of-order seq: ${msg.seq}`;
      this.lastSeqIn = msg.seq;
      this.persistSeqIn();
    }
    return null;
  }

  // A14-2：lastSeqIn 持久化（原子写；重启后拒绝重放更早 seq）。
  // 文件按 host 实例分键；写失败不阻断内存校验（重启后窗口重放会被账本幂等兜底）。
  private persistSeqIn(): void {
    if (!this.seqStatePath) return;
    try {
      fs.mkdirSync(path.dirname(this.seqStatePath), { recursive: true });
      fs.writeFileSync(`${this.seqStatePath}.tmp`, JSON.stringify({
        host_instance_id: this.hostInfo?.host_instance_id ?? '',
        last_seq_in: this.lastSeqIn,
        at: Date.now(),
      }));
      fs.renameSync(`${this.seqStatePath}.tmp`, this.seqStatePath);
    } catch { /* 持久化失败不阻断 */ }
  }

  /** 配对确认/启动时恢复持久化的 lastSeqIn（同 host 才生效）。 */
  private restoreSeqIn(hostInstanceID: string): void {
    if (!this.seqStatePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.seqStatePath, 'utf8')) as { host_instance_id?: string; last_seq_in?: number };
      if (raw.host_instance_id === hostInstanceID && typeof raw.last_seq_in === 'number') {
        if (raw.last_seq_in > this.lastSeqIn) this.lastSeqIn = raw.last_seq_in;
      }
    } catch { /* 首次无状态 */ }
  }

  private send(msg: BridgeEnvelope): void {
    if (!this.socket || this.socket.destroyed) {
      this.emit('log', `send drop: socket=${Boolean(this.socket)} destroyed=${this.socket?.destroyed ?? 'n/a'} type=${msg.type}`);
      return;
    }
    const key = this.signKey();
    if (key && msg.type !== 'pairing_start') {
      this.seqOut += 1;
      msg.seq = this.seqOut;
      // A14-5：签名材料含 nonce/payload_hash（command/result 信封带值）。
      const nonce = typeof msg.nonce === 'string' ? msg.nonce : '';
      const payloadHash = typeof msg.payload_hash === 'string' ? msg.payload_hash : '';
      msg.hmac = hmacSign(key, this.seqOut, msg.type, msg.payload, nonce, payloadHash);
    }
    this.emit('log', `-> ${msg.type} seq=${msg.seq ?? '-'} peer=${this.socket.remotePort}`);
    this.socket.write(`${JSON.stringify(msg)}\n`);
  }

  private onEnvelope(msg: BridgeEnvelope): void {
    const err = this.checkEnvelope(msg);
    if (err) {
      this.emit('log', `reject envelope: ${err}`);
      return;
    }
    if (msg.type === 'hello') {
      const payload = (msg.payload ?? {}) as { host_instance_id?: string; pid?: number; protocol_version?: number; extension_instance_id?: string };
      // A30b：两种 hello 走两条路。扩展 hello（native host 透传，无 host_instance_id、
      // 带 extension_instance_id）只记录实例 ID，不重置配对——MV3 service worker 唤醒
      // 重连不该打断已建立的 HMAC 会话；配对流程由宿主 hello 驱动（既有语义不变）。
      if (!payload.host_instance_id && payload.extension_instance_id) {
        this.extensionInstanceId = String(payload.extension_instance_id).slice(0, 64) || null;
        this.emit('log', `extension hello: instance=${(this.extensionInstanceId ?? '').slice(0, 8)}`);
        return;
      }
      this.hostInfo = { host_instance_id: String(payload.host_instance_id ?? ''), pid: Number(payload.pid ?? 0), connected_at: Date.now() };
      this.extensionInstanceId = null;
      // A14-2：同一 host 实例重连（桥重启/新会话）恢复已见最大 seq；新实例从 0 起算。
      this.lastSeqIn = 0;
      if (this.hostInfo.host_instance_id) this.restoreSeqIn(this.hostInfo.host_instance_id);
      this.state = 'pairing';
      this.pairing = {
        id: crypto.randomUUID(),
        code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
        expires_at: Date.now() + PAIRING_TTL_MS,
      };
      this.sessionKey = null;
      this.seqOut = 0;
      this.pendingNonce.clear();
      // A14-6：按宿主在 hello 里声明的能力协商信封加密版本。未声明（旧宿主）保持 v1。
      const versions = (payload as { crypto_versions?: unknown }).crypto_versions;
      this.cryptoVersion = Array.isArray(versions) && versions.includes(CRYPTO_VERSION_V2)
        ? CRYPTO_VERSION_V2
        : CRYPTO_VERSION_V1;
      this.hkdfSalt = null;
      this.messageKey = null;
      this.send({ v: PROTOCOL_VERSION, type: 'pairing_start', payload: { pairing_id: this.pairing.id, code: this.pairing.code, expires_at: this.pairing.expires_at } });
      this.emit('pairing', `pairing started, code ${this.pairing.code} host=${payload.host_instance_id?.slice(0, 8)} pid=${payload.pid} crypto=v${this.cryptoVersion}`);
      if (this.autoPair) setTimeout(() => void this.confirmPairing(), 200);
      return;
    }
    if (msg.type === 'result') {
      const requestId = String(msg.request_id ?? '');
      const entry = this.ledger.get(requestId);
      if (!entry) {
        this.emit('log', `result for unknown request ${requestId}; drop`);
        return;
      }
      // 回执必须对应一次真实派发且 nonce/payload_hash 一致（27 §13.5 防错配/防伪造回执）。
      const pending = this.pendingNonce.get(requestId);
      if (!pending) {
        this.emit('log', `result ${requestId} without pending dispatch; drop`);
        return;
      }
      if (typeof msg.nonce !== 'string' || msg.nonce !== pending.nonce) {
        this.emit('log', `result ${requestId} nonce mismatch; drop`);
        return;
      }
      if (typeof msg.payload_hash !== 'string' || msg.payload_hash !== pending.payload_hash) {
        this.emit('log', `result ${requestId} payload_hash mismatch; drop`);
        return;
      }
      this.pendingNonce.delete(requestId);
      const payload = (msg.payload ?? {}) as { ok?: boolean; error_code?: string };
      const to = payload.ok ? 'succeeded' : 'failed';
      const updated = this.ledger.transition(requestId, to, { result: msg.payload, error_code: payload.error_code });
      if (updated) this.emit('result', `${requestId} ${updated.action} -> ${updated.state}${payload.error_code ? ` (${payload.error_code})` : ''}`);
      return;
    }
    if (msg.type === 'revoke') {
      this.state = 'revoked';
      this.sessionKey = null;
      this.messageKey = null;
      this.hkdfSalt = null;
      this.cryptoVersion = CRYPTO_VERSION_V1;
      this.pairing = null;
      this.emit('revoke', 'host confirmed revoke');
    }
    if (msg.type === 'error') {
      this.emit('log', `host/extension error: ${JSON.stringify(msg.payload ?? null)}`);
      return;
    }
    // DEV-AI27-10（W10b）：侧栏草稿→原会话（27 §10.2：真实受理在 OPS 业务窗；
    // 桥只做深链转发到渲染器，由渲染器将草稿填入输入台待用户发送——无双执行入口）。
    if (msg.type === 'ping' && msg.payload && typeof msg.payload === 'object') {
      const p = msg.payload as { sidepanel?: string; text?: string };
      if (p.sidepanel === 'draft' && typeof p.text === 'string' && p.text.trim()) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.webContents.getURL().includes(businessUrlHint())) {
            win.webContents.send('desktop-ui:sidepanel-draft', { text: p.text.slice(0, 2000) });
            this.emit('log', `sidepanel draft forwarded (${p.text.length} chars)`);
            break;
          }
        }
      } else if (p.sidepanel === 'stop') {
        // 停止任务：转发业务窗（渲染器调用既有 run cancel API——与主界面停止同语义）。
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.webContents.getURL().includes(businessUrlHint())) {
            win.webContents.send('desktop-ui:sidepanel-stop');
            this.emit('log', 'sidepanel stop forwarded');
            break;
          }
        }
      }
      // 其他 ping（focus_ops 等）忽略。
    }
  }

  /** 人工核对短码后确认配对；仅 pairing 态且未过期有效。 */
  confirmPairing(): { ok: boolean; reason?: string } {
    if (this.state !== 'pairing' || !this.pairing) return { ok: false, reason: 'not pairing' };
    if (Date.now() > this.pairing.expires_at) {
      this.pairing = null;
      this.state = 'unpaired';
      return { ok: false, reason: 'pairing expired' };
    }
    this.sessionKey = crypto.randomBytes(32);
    // A14-6：v2 需要本次配对独有的 HKDF salt；根密钥只用于派生，不进入签名路径。
    const payload: Record<string, unknown> = {
      pairing_id: this.pairing.id,
      session_key: this.sessionKey.toString('base64'),
      crypto_version: this.cryptoVersion,
    };
    if (this.cryptoVersion === CRYPTO_VERSION_V2) {
      this.hkdfSalt = crypto.randomBytes(32);
      this.messageKey = deriveMessageKey(this.sessionKey, this.hkdfSalt);
      payload.hkdf_salt = this.hkdfSalt.toString('base64');
    } else {
      this.hkdfSalt = null;
      this.messageKey = null;
    }
    this.send({ v: PROTOCOL_VERSION, type: 'pairing_confirm', payload });
    this.state = 'paired';
    this.emit('state', 'paired');
    return { ok: true };
  }

  /** 停止/撤销：generation 递增，旧命令永久失效；不回滚已派发动作。 */
  revoke(reason: string): void {
    this.generation.n += 1;
    this.send({ v: PROTOCOL_VERSION, type: 'revoke', payload: { generation: this.generation.n, reason } });
    this.state = 'revoked';
    this.pairing = null;
    this.sessionKey = null;
    this.messageKey = null;
    this.hkdfSalt = null;
    this.cryptoVersion = CRYPTO_VERSION_V1;
    this.pendingNonce.clear();
    for (const entry of this.ledger.list()) {
      if (entry.state === 'queued') this.ledger.transition(entry.request_id, 'cancelled');
    }
    this.emit('revoke', `generation=${this.generation.n} ${reason}`);
  }

  /** 派发登记动作。同 id 同载荷幂等返回既有状态；同 id 异载荷拒绝；未配对/已撤销拒绝。 */
  dispatch(action: string, payload: unknown, requestId?: string): { accepted: boolean; request_id?: string; state?: LedgerState; error_code?: BridgeErrorCode; reason?: string } {
    if (this.state !== 'paired' || !this.sessionKey) {
      return { accepted: false, error_code: 'browser_not_paired', reason: `bridge not paired (state=${this.state})` };
    }
    if (!ALLOWED_ACTIONS.has(action)) {
      // 桥侧前置白名单；扩展侧登记表是第二道校验（27 §12.2 双侧校验）。
      this.emit('log', `dispatch rejected: action not registered (${action})`);
      return { accepted: false, error_code: 'browser_action_unsupported', reason: `action not registered: ${action}` };
    }
    if (this.clockDriftMs() > CLOCK_TOLERANCE_MS) {
      // 27 §13.5：时钟异常停止派发。
      this.emit('log', `dispatch rejected: clock drift ${this.clockDriftMs().toFixed(0)}ms exceeds ${CLOCK_TOLERANCE_MS}ms`);
      return { accepted: false, error_code: 'browser_clock_unstable', reason: 'wall clock unstable; dispatch paused' };
    }
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
    if (bodyBytes > MAX_METADATA_BYTES) {
      this.emit('log', `dispatch rejected: payload ${bodyBytes}B > ${MAX_METADATA_BYTES}B`);
      return { accepted: false, error_code: 'browser_payload_limit', reason: `metadata payload exceeds ${MAX_METADATA_BYTES} bytes` };
    }
    const id = requestId ?? crypto.randomUUID();
    const hash = inputHash(action, payload);
    const rec = this.ledger.record(id, action, hash, Date.now());
    if ('conflict' in rec) {
      return { accepted: false, request_id: id, error_code: 'browser_request_conflict', reason: 'request_id conflict with different input' };
    }
    const entry = rec.entry;
    if (entry.state !== 'queued') {
      return { accepted: true, request_id: id, state: entry.state, reason: 'idempotent replay returns original state' };
    }
    const deadline = Date.now() + this.actionTimeoutMs;
    // 27 §13.5 信封完整化：issued_at/nonce/payload_hash；回执须原样带回以证明对应同一次派发。
    const nonce = crypto.randomBytes(16).toString('hex');
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
    this.pendingNonce.set(id, { nonce, payload_hash: payloadHash });
    this.send({
      v: PROTOCOL_VERSION,
      type: 'command',
      request_id: id,
      generation: this.generation.n,
      issued_at: Date.now(),
      deadline_at: deadline,
      nonce,
      action,
      payload,
      payload_hash: payloadHash,
    });
    this.ledger.transition(id, 'dispatched', { dispatched_at: Date.now(), deadline_at: deadline });
    this.emit('dispatch', `${id} ${action} generation=${this.generation.n}`);
    return { accepted: true, request_id: id, state: 'dispatched' };
  }

  /** 定期把超时未回执的命令记为 unknown_outcome（先核对、不重放），并清理对应 nonce 待核记录。 */
  sweep(): void {
    for (const entry of this.ledger.sweepUnknown(Date.now())) {
      this.pendingNonce.delete(entry.request_id);
      this.emit('result', `${entry.request_id} ${entry.action} -> unknown_outcome (no receipt before deadline)`);
    }
  }

  /** A30：派发并等待回执——本机 UI 主动枚举用（选标签弹窗的 tabs_list），不进服务端账本。
   * 成功返回扩展动作 payload；失败/超时返回真实错误码，调用方如实提示，不伪造列表。 */
  dispatchAndWait(action: string, payload: unknown, timeoutMs = 15000): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message?: string }> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const deadline = Date.now() + timeoutMs;
      let done = false;
      const finish = (r: { ok: true; result: unknown } | { ok: false; code: string; message?: string }): void => {
        if (done) return;
        done = true;
        clearInterval(timer);
        resolve(r);
      };
      const timer = setInterval(() => {
        const entry = this.ledger.get(id);
        if (!entry) {
          if (Date.now() > deadline) finish({ ok: false, code: 'browser_dispatch_timeout' });
          return;
        }
        if (entry.state === 'succeeded') {
          const result = (entry.result ?? {}) as { payload?: unknown; error_code?: string };
          if (result.payload !== undefined) finish({ ok: true, result: result.payload });
          else finish({ ok: false, code: result.error_code ?? 'browser_action_failed' });
          return;
        }
        if (entry.state === 'failed') {
          const result = (entry.result ?? {}) as { error_code?: string; message?: string };
          finish({ ok: false, code: result.error_code ?? 'browser_action_failed', message: result.message });
          return;
        }
        // dispatched 未回执超过截止（含 sweep 容差）即视为 unknown_outcome；其余终态直报。
        if (entry.state === 'unknown_outcome' || entry.state === 'cancelled' || Date.now() > deadline + 2000) {
          finish({ ok: false, code: entry.state === 'dispatched' || entry.state === 'queued' ? 'browser_dispatch_timeout' : `browser_${entry.state}` });
        }
      }, 100);
      const dispatched = this.dispatch(action, payload, id);
      if (!dispatched.accepted) {
        finish({ ok: false, code: dispatched.error_code ?? 'browser_dispatch_rejected', message: dispatched.reason });
      }
    });
  }

  private async onControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code);
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && (req.url === '/state' || req.url === '/')) {
      reply(200, this.snapshot());
      return;
    }
    if (req.method === 'POST' && req.url === '/confirm-pairing') {
      reply(200, this.confirmPairing());
      return;
    }
    if (req.method === 'POST' && req.url === '/revoke') {
      this.revoke('control request');
      reply(200, { ok: true, generation: this.generation.n });
      return;
    }
    if (req.method === 'POST' && req.url === '/dispatch') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed: { action?: string; payload?: unknown; request_id?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        reply(400, { error: 'bad json' });
        return;
      }
      if (!parsed.action) {
        reply(400, { error: 'action required' });
        return;
      }
      reply(200, this.dispatch(parsed.action, parsed.payload ?? {}, parsed.request_id));
      return;
    }
    reply(404, { error: 'not found' });
  }
}

// ---------------------------------------------------------------------------
// 启动入口（A30b：产品路径 ensureProductBridge 常驻启动；诊断模式只补开诊断窗）
// ---------------------------------------------------------------------------

let activeBridge: BrowserBridge | null = null;

/** 业务窗 URL 提示串（5173 开发/生产 origin 都覆盖；与 main.ts businessOrigin 对齐）。 */
function businessUrlHint(): string {
  return process.env.OPS_DESKTOP_DEV_URL ? 'localhost' : 'ops-desktop';
}

export function getActiveBridge(): BrowserBridge | null {
  return activeBridge;
}

/** DT-03（docs/33 §10.7）：应用退出统一清理的桥步骤——停止 8765 桥端口与控制端口
 * 监听并清空单例。此后浏览器协作 IPC 如实报「桥未运行」。重复调用幂等。 */
export function stopActiveBridge(): void {
  if (!activeBridge) return;
  activeBridge.stop();
  activeBridge = null;
}

/** 诊断 IPC 来源守卫签名：拒绝时抛错（invoke 直接 reject），与 main.ts 的
 * requireComputerCaller/requireRealtimeCaller 同构——只放行诊断窗主框架。 */
export type DiagnosticsCallerGuard = (event: { sender: unknown; senderFrame: { url: string } | null }) => void;

/** DT-02（docs/33 §10.3）：诊断通道注册。修复前 4 个 handler 忽略 event、无来源
 * 校验，而产品路径无条件注册——业务窗等任何 frame 都能 confirm/revoke/dispatch。
 * 现在 callerGuard 是必经守卫：未提供时按缺省严格语义一律拒绝，不允许无守卫注册。
 * revoke 返回值同步修正：桥未运行时如实 {ok:false,reason}，不再无条件 {ok:true}
 * （confirm-pairing/dispatch 未运行的拒绝语义保持既有口径）。 */
export function registerDiagnosticsIpc(callerGuard: DiagnosticsCallerGuard | undefined, getBridge: () => BrowserBridge | null = getActiveBridge): void {
  const guard = (event: unknown): void => {
    if (!callerGuard) throw new Error('不允许此窗口调用浏览器桥诊断意图。');
    callerGuard(event as Parameters<DiagnosticsCallerGuard>[0]);
  };
  ipcMain.handle('ops-bridge-diag:get-state', (event) => {
    guard(event);
    return getBridge()?.snapshot() ?? null;
  });
  ipcMain.handle('ops-bridge-diag:confirm-pairing', (event) => {
    guard(event);
    return getBridge()?.confirmPairing() ?? { ok: false, reason: 'bridge not running' };
  });
  ipcMain.handle('ops-bridge-diag:revoke', (event) => {
    guard(event);
    const bridge = getBridge();
    if (!bridge) return { ok: false as const, reason: 'bridge not running' };
    bridge.revoke('diagnostics window');
    return { ok: true as const, generation: bridge.generation.n };
  });
  ipcMain.handle('ops-bridge-diag:dispatch', (event, action: string, payload: unknown) => {
    guard(event);
    return getBridge()?.dispatch(String(action), payload) ?? { accepted: false, reason: 'bridge not running' };
  });
}

/** 测试注入点：替换 ipcMain 与桥来源，锁定注册形状与守卫语义。与生产
 * registerDiagnosticsIpc 保持同一 guard 包装与返回值口径（改一处须同步另一处）。 */
export function registerDiagnosticsIpcForTest(
  ipcMainLike: Pick<typeof ipcMain, 'handle'>,
  callerGuard: DiagnosticsCallerGuard | undefined,
  getBridge: () => BrowserBridge | null,
): void {
  const guard = (event: unknown): void => {
    if (!callerGuard) throw new Error('不允许此窗口调用浏览器桥诊断意图。');
    callerGuard(event as Parameters<DiagnosticsCallerGuard>[0]);
  };
  ipcMainLike.handle('ops-bridge-diag:get-state', (event: unknown) => {
    guard(event);
    return getBridge()?.snapshot() ?? null;
  });
  ipcMainLike.handle('ops-bridge-diag:confirm-pairing', (event: unknown) => {
    guard(event);
    return getBridge()?.confirmPairing() ?? { ok: false, reason: 'bridge not running' };
  });
  ipcMainLike.handle('ops-bridge-diag:revoke', (event: unknown) => {
    guard(event);
    const bridge = getBridge();
    if (!bridge) return { ok: false as const, reason: 'bridge not running' };
    bridge.revoke('diagnostics window');
    return { ok: true as const, generation: bridge.generation.n };
  });
  ipcMainLike.handle('ops-bridge-diag:dispatch', (event: unknown, action: string, payload: unknown) => {
    guard(event);
    return getBridge()?.dispatch(String(action), payload) ?? { accepted: false, reason: 'bridge not running' };
  });
}

function createBridge(): BrowserBridge {
  const ledgerPath = path.join(process.cwd(), '.tmp', 'browser-bridge-ledger.json');
  return new BrowserBridge(new CommandLedger(ledgerPath), {
    // A14-2：lastSeqIn 持久化（重启后拒绝重放更早 seq）。
    seqStatePath: path.join(process.cwd(), '.tmp', 'browser-bridge-seq.json'),
    port: BRIDGE_PORT,
    controlPort: CONTROL_PORT,
    autoPair: process.env.OPS_DESKTOP_BRIDGE_AUTO_PAIR === '1',
    log: (line) => console.log(line),
  });
}

/** 桥就绪后的公共接线：控制端口、诊断窗推送。 */
async function wireBridge(bridge: BrowserBridge): Promise<void> {
  try {
    await bridge.startControl(CONTROL_PORT);
  } catch (err) {
    bridge.emit('log', `control port unavailable: ${(err as Error).message}`);
  }
  bridge.onUpdate(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.getURL().includes('diagnostics.html')) {
        win.webContents.send('ops-bridge-diag:update', bridge.snapshot());
      }
    }
  });
}

/** A30b（用户拍板：常驻启动）：产品路径启动浏览器桥并常驻监听 127.0.0.1:8765。
 * 启动失败（典型：端口被占用）时如实降级——不崩溃、不重试轰炸、返回 false，
 * 调用方记录一条日志即可；浏览器协作相关 IPC 会如实报"桥未运行"。 */
export async function ensureProductBridge(): Promise<boolean> {
  if (activeBridge) return true;
  const bridge = createBridge();
  try {
    await bridge.start();
  } catch (err) {
    bridge.stop();
    console.log(`[browser-bridge] 桥启动失败（端口可能被占用）：${(err as Error).message}`);
    return false;
  }
  activeBridge = bridge;
  registerDiagnosticsIpc(diagnosticsCallerGuard);
  await wireBridge(bridge);
  return true;
}

/** 生产诊断来源守卫：只放行 URL 含 diagnostics.html 的窗口主框架。诊断窗由
 * startBrowserBridgeDiagnostics 创建，其 preload 只暴露固定意图；业务窗与其它
 * frame 一律拒绝。诊断窗尚未创建时同样拒绝（守卫按 URL 判定，无需窗口引用）。 */
const diagnosticsCallerGuard: DiagnosticsCallerGuard = (event) => {
  const url = String(event.senderFrame?.url ?? '');
  if (!url.includes('diagnostics.html')) {
    throw new Error('不允许此窗口调用浏览器桥诊断意图。');
  }
};

/** A30b：诊断模式。桥已由 ensureProductBridge 常驻启动时复用同一实例，只补开诊断窗；
 * 桥未运行（如端口被占）时仍开窗如实显示"桥未运行"，保留 W02 调试语义。 */
export async function startBrowserBridgeDiagnostics(): Promise<BrowserBridge | null> {
  const bridge = getActiveBridge();
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    title: 'OPS 浏览器桥诊断（W02 验证）',
    webPreferences: {
      preload: path.join(__dirname, 'diagnostics-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(__dirname, 'browser-bridge', 'diagnostics.html'));
  return bridge;
}
