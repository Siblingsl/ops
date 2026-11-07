import { BrowserWindow, ipcMain } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

// DEV-AI27-02 W02 技术验证：OPS 桌面浏览器桥。
// 回环 TCP(8765, NDJSON) <-> native-host <-> Chrome 扩展。
// 配对（短码人工核对）→ HMAC 会话 → 登记动作派发 → 命令账本（幂等/超时 unknown_outcome）。
// 仅在 OPS_DESKTOP_BRIDGE_DIAG=1 时由 main.ts 启动；不启用时不监听任何端口。

export const PROTOCOL_VERSION = 1;
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
  deadline_at?: number;
  action?: string;
  payload?: unknown;
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

function hmacSign(key: Buffer, seq: number, type: string, payload: unknown): string {
  return crypto.createHmac('sha256', key).update(`${seq}.${type}.${JSON.stringify(payload ?? null)}`).digest('base64');
}

function verifyHmac(key: Buffer, seq: number, type: string, payload: unknown, got: string): boolean {
  const expect = Buffer.from(hmacSign(key, seq, type, payload));
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
  autoPair?: boolean;
  actionTimeoutMs?: number;
  log?: (line: string) => void;
}

export class BrowserBridge {
  readonly generation = { n: 0 };
  state: BridgeState = 'unpaired';
  pairing: { id: string; code: string; expires_at: number } | null = null;
  hostInfo: { host_instance_id: string; pid: number; connected_at: number } | null = null;

  private server: net.Server | null = null;
  private controlServer: http.Server | null = null;
  private socket: net.Socket | null = null;
  private sessionKey: Buffer | null = null;
  private seqOut = 0;
  private lastSeqIn = 0;
  private lineBuf = '';
  private events: BridgeEvent[] = [];
  private updateCbs = new Set<() => void>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly actionTimeoutMs: number;
  private readonly autoPair: boolean;
  private readonly log: (line: string) => void;

  constructor(
    readonly ledger: CommandLedger,
    private readonly opts: BridgeOptions = {},
  ) {
    this.actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.autoPair = opts.autoPair ?? false;
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

  private checkEnvelope(msg: BridgeEnvelope): string | null {
    if (msg.v !== PROTOCOL_VERSION) return `protocol version mismatch: ${msg.v}`;
    if (!TRUSTED_TYPES.has(msg.type)) return `type not allowed: ${msg.type}`;
    // hello/pairing_start 是配对起点，永远免签；收到即视为重新配对（下方处理时重置会话）。
    if (this.sessionKey && msg.type !== 'pairing_start' && msg.type !== 'hello') {
      if (typeof msg.seq !== 'number' || typeof msg.hmac !== 'string') return 'missing seq/hmac';
      if (!verifyHmac(this.sessionKey, msg.seq, msg.type, msg.payload, msg.hmac)) return 'hmac verification failed';
      if (msg.seq <= this.lastSeqIn) return `replayed or out-of-order seq: ${msg.seq}`;
      this.lastSeqIn = msg.seq;
    }
    return null;
  }

  private send(msg: BridgeEnvelope): void {
    if (!this.socket || this.socket.destroyed) {
      this.emit('log', `send drop: socket=${Boolean(this.socket)} destroyed=${this.socket?.destroyed ?? 'n/a'} type=${msg.type}`);
      return;
    }
    if (this.sessionKey && msg.type !== 'pairing_start') {
      this.seqOut += 1;
      msg.seq = this.seqOut;
      msg.hmac = hmacSign(this.sessionKey, this.seqOut, msg.type, msg.payload);
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
      const payload = (msg.payload ?? {}) as { host_instance_id?: string; pid?: number; protocol_version?: number };
      this.hostInfo = { host_instance_id: String(payload.host_instance_id ?? ''), pid: Number(payload.pid ?? 0), connected_at: Date.now() };
      this.state = 'pairing';
      this.pairing = {
        id: crypto.randomUUID(),
        code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
        expires_at: Date.now() + PAIRING_TTL_MS,
      };
      this.sessionKey = null;
      this.lastSeqIn = 0;
      this.seqOut = 0;
      this.send({ v: PROTOCOL_VERSION, type: 'pairing_start', payload: { pairing_id: this.pairing.id, code: this.pairing.code, expires_at: this.pairing.expires_at } });
      this.emit('pairing', `pairing started, code ${this.pairing.code} host=${payload.host_instance_id?.slice(0, 8)} pid=${payload.pid}`);
      if (this.autoPair) setTimeout(() => void this.confirmPairing(), 200);
      return;
    }    if (msg.type === 'result') {
      const requestId = String(msg.request_id ?? '');
      const entry = this.ledger.get(requestId);
      if (!entry) {
        this.emit('log', `result for unknown request ${requestId}; drop`);
        return;
      }
      const payload = (msg.payload ?? {}) as { ok?: boolean; error_code?: string };
      const hash = inputHash(entry.action, msg.payload);
      if (hash !== entry.input_hash && payload.ok === false) {
        // 回执载荷不同不阻断记账（回执非输入）；仅拒绝同 id 异输入的新命令（record 已处理）。
      }
      const to = payload.ok ? 'succeeded' : 'failed';
      const updated = this.ledger.transition(requestId, to, { result: msg.payload, error_code: payload.error_code });
      if (updated) this.emit('result', `${requestId} ${updated.action} -> ${updated.state}${payload.error_code ? ` (${payload.error_code})` : ''}`);
      return;
    }
    if (msg.type === 'revoke') {
      this.state = 'revoked';
      this.sessionKey = null;
      this.pairing = null;
      this.emit('revoke', 'host confirmed revoke');
    }
    if (msg.type === 'error') {
      this.emit('log', `host/extension error: ${JSON.stringify(msg.payload ?? null)}`);
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
    this.send({
      v: PROTOCOL_VERSION,
      type: 'pairing_confirm',
      payload: { pairing_id: this.pairing.id, session_key: this.sessionKey.toString('base64') },
    });
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
    for (const entry of this.ledger.list()) {
      if (entry.state === 'queued') this.ledger.transition(entry.request_id, 'cancelled');
    }
    this.emit('revoke', `generation=${this.generation.n} ${reason}`);
  }

  /** 派发登记动作。同 id 同载荷幂等返回既有状态；同 id 异载荷拒绝；未配对/已撤销拒绝。 */
  dispatch(action: string, payload: unknown, requestId?: string): { accepted: boolean; request_id?: string; state?: LedgerState; reason?: string } {
    if (this.state !== 'paired' || !this.sessionKey) {
      return { accepted: false, reason: `bridge not paired (state=${this.state})` };
    }
    const id = requestId ?? crypto.randomUUID();
    const hash = inputHash(action, payload);
    const rec = this.ledger.record(id, action, hash, Date.now());
    if ('conflict' in rec) return { accepted: false, request_id: id, reason: 'request_id conflict with different input' };
    const entry = rec.entry;
    if (entry.state !== 'queued') {
      return { accepted: true, request_id: id, state: entry.state, reason: 'idempotent replay returns original state' };
    }
    const deadline = Date.now() + this.actionTimeoutMs;
    this.send({
      v: PROTOCOL_VERSION,
      type: 'command',
      request_id: id,
      generation: this.generation.n,
      deadline_at: deadline,
      action,
      payload,
    });
    this.ledger.transition(id, 'dispatched', { dispatched_at: Date.now(), deadline_at: deadline });
    this.emit('dispatch', `${id} ${action} generation=${this.generation.n}`);
    return { accepted: true, request_id: id, state: 'dispatched' };
  }

  /** 定期把超时未回执的命令记为 unknown_outcome（先核对、不重放）。 */
  sweep(): void {
    for (const entry of this.ledger.sweepUnknown(Date.now())) {
      this.emit('result', `${entry.request_id} ${entry.action} -> unknown_outcome (no receipt before deadline)`);
    }
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
// 诊断窗与启动入口（main.ts 仅调用 startBrowserBridgeDiagnostics）
// ---------------------------------------------------------------------------

let activeBridge: BrowserBridge | null = null;

export function getActiveBridge(): BrowserBridge | null {
  return activeBridge;
}

function registerIpc(): void {
  ipcMain.handle('ops-bridge-diag:get-state', () => getActiveBridge()?.snapshot() ?? null);
  ipcMain.handle('ops-bridge-diag:confirm-pairing', () => getActiveBridge()?.confirmPairing() ?? { ok: false, reason: 'bridge not running' });
  ipcMain.handle('ops-bridge-diag:revoke', () => {
    getActiveBridge()?.revoke('diagnostics window');
    return { ok: true };
  });
  ipcMain.handle('ops-bridge-diag:dispatch', (_e, action: string, payload: unknown) => getActiveBridge()?.dispatch(String(action), payload) ?? { accepted: false, reason: 'bridge not running' });
}

export async function startBrowserBridgeDiagnostics(): Promise<BrowserBridge> {
  if (activeBridge) return activeBridge;
  const ledgerPath = path.join(process.cwd(), '.tmp', 'browser-bridge-ledger.json');
  const bridge = new BrowserBridge(new CommandLedger(ledgerPath), {
    port: BRIDGE_PORT,
    controlPort: CONTROL_PORT,
    autoPair: process.env.OPS_DESKTOP_BRIDGE_AUTO_PAIR === '1',
    log: (line) => console.log(line),
  });
  activeBridge = bridge;
  registerIpc();
  await bridge.start();
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
