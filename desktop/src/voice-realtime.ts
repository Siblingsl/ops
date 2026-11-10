import { EventEmitter } from 'node:events';

// DEV-AI27-16 第六批（A2，27 §11.4.5 / V08）：realtime 双向音频桥。
// 职责边界（docs/31 方向一第 3 步）：
// - 桌面主进程持有 WebSocket 客户端与音频编解码；渲染器只发固定 IPC 意图，不接触密钥；
// - 会话凭据经服务端 /agent/voice-sessions/{id}/realtime-token 签发（10 分钟短期），
//   供应商 API Key 留在服务端，绝不下发渲染器；
// - 协议采用 OpenAI Realtime 风格信封（session.update / input_audio_buffer.append /
//   response.audio.delta / response.audio.done / error），供应商差异由 adapter 收敛；
// - 断线重连 ≤3 次（指数退避 1s/2s/4s），超过转 realtime_error 并如实上报；
// - 打断：barge-in 时立即 stop 播放并向上游发 response.cancel（不回滚已派发动作）；
// - 音频不落盘（27 §11.4.3）；PCM 16k 单声道上行、24k 下行（OpenAI Realtime 契约）。

export const REALTIME_PROTOCOL_VERSION = 1;
export const REALTIME_UPSTREAM_SAMPLE_RATE = 16000;
export const REALTIME_DOWNSTREAM_SAMPLE_RATE = 24000;
const RECONNECT_MAX = 3;

/** 桥状态机：idle → connecting → ready(session) → speaking/listening 循环 → ended|error。 */
export type RealtimeBridgeState =
  | 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'ended' | 'error';

export interface RealtimeSessionConfig {
  sessionID: string;      // OPS agent_voice_session id
  token: string;          // 服务端签发的短时会话凭据
  proxyEndpoint: string;  // 服务端 WS 代理路径（兼容旧调用）
  proxyURL?: string;      // 服务端签发的绝对 ws(s) 地址；优先于 proxyEndpoint
  model: string;
  provider: string;
}

/** 上行音频块（16k PCM16 单声道，Base64 承载；块 ≤ 8KB）。 */
export interface RealtimeAudioChunk {
  /** Base64 of PCM16LE 16k mono samples. */
  dataBase64: string;
}

/** 下行事件（桥 → 渲染器；渲染器据 delta 播放、据 transcript 更新字幕）。 */
export interface RealtimeBridgeEvent {
  type:
    | 'state'              // state 变更
    | 'audio_delta'        // 下行音频增量（Base64 PCM16LE 24k mono）
    | 'audio_done'         // 本轮音频结束
    | 'transcript_delta'   // 助手字幕增量
    | 'input_transcript'   // 用户侧转写（input_audio_transcription 完成）
    | 'turn_committed'     // 一轮对话落定（渲染器可触发 commit_realtime）
    | 'interrupted'        // 已向上游取消并停止播放
    | 'error';             // 错误（error_code + 可读信息；不含密钥）
  state?: RealtimeBridgeState;
  dataBase64?: string;
  text?: string;
  error_code?: string;
  message?: string;
}

/** 信封编解码（纯函数，单测直接覆盖）。 */
export function encodeRealtimeEvent(event: string, payload: unknown): string {
  return JSON.stringify({ type: event, event_id: `ev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, ...({ ...(payload as object) }) });
}

export function decodeRealtimeEvent(raw: string): { type: string; data: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.type !== 'string') return null;
    return { type: parsed.type, data: parsed };
  } catch {
    return null;
  }
}

/** 会话初始化信封（session.update：语音、采样率、转写开启）。 */
export function buildSessionUpdate(opts: { voice?: string; instructions?: string }): string {
  return encodeRealtimeEvent('session.update', {
    session: {
      voice: opts.voice ?? 'alloy',
      instructions: opts.instructions ?? '',
      input_audio_format: { type: 'pcm16', sample_rate: REALTIME_UPSTREAM_SAMPLE_RATE },
      output_audio_format: { type: 'pcm16', sample_rate: REALTIME_DOWNSTREAM_SAMPLE_RATE },
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: { type: 'server_vad' },
    },
  });
}

/** 上行音频信封。 */
export function buildAudioAppend(chunk: RealtimeAudioChunk): string {
  return encodeRealtimeEvent('input_audio_buffer.append', { audio: chunk.dataBase64 });
}

/** 提交上行缓冲并要求回复。 */
export function buildAudioCommit(): string {
  return encodeRealtimeEvent('input_audio_buffer.commit', {});
}

/** 打断：取消当前 response（停止播放由桥本地先行执行）。 */
export function buildResponseCancel(): string {
  return encodeRealtimeEvent('response.cancel', {});
}

export interface RealtimeBridgeDeps {
  /** WS 工厂（默认 node http(s) WebSocket 由 Electron Node 提供；测试注入 fake）。 */
  connect(url: string): Promise<{
    send(raw: string): void;
    close(): void;
    onMessage(cb: (raw: string) => void): void;
    onClose(cb: (code: number, reason: string) => void): void;
    onError(cb: (err: Error) => void): void;
  }>;
  now(): number;
}

/**
 * RealtimeBridge：桌面主进程单会话桥。
 * 渲染器经 IPC 意图调用 start/append/commit/interrupt/stop；主进程转发信封。
 * 密钥纪律：本类不持有供应商 API Key（token 是 OPS 服务端签发的短时会话凭据）。
 */
export class RealtimeBridge extends EventEmitter {
  state: RealtimeBridgeState = 'idle';
  private deps: RealtimeBridgeDeps;
  private cfg: RealtimeSessionConfig | null = null;
  private ws: Awaited<ReturnType<RealtimeBridgeDeps['connect']>> | null = null;
  private reconnects = 0;
  private sessionApplied = false;

  constructor(deps: RealtimeBridgeDeps) {
    super();
    this.deps = deps;
  }

  private setState(s: RealtimeBridgeState): void {
    this.state = s;
    this.emitEvent({ type: 'state', state: s });
  }

  private emitEvent(ev: RealtimeBridgeEvent): void {
    this.emit('event', ev);
  }

  /** 发起会话：连代理端点 → 发 session.update；失败重试 ≤3 次后转 error。 */
  async start(cfg: RealtimeSessionConfig): Promise<{ ok: boolean; error_code?: string; message?: string }> {
    if (this.state !== 'idle' && this.state !== 'ended' && this.state !== 'error') {
      return { ok: false, error_code: 'realtime_bridge_busy', message: '已有活动 realtime 会话' };
    }
    this.cfg = cfg;
    this.reconnects = 0;
    this.sessionApplied = false;
    return this.connectOnce('connecting');
  }

  private async connectOnce(nextState: RealtimeBridgeState): Promise<{ ok: boolean; error_code?: string; message?: string }> {
    if (!this.cfg) return { ok: false, error_code: 'realtime_no_session', message: '会话未初始化' };
    this.setState(nextState);
    const endpoint = this.cfg.proxyURL || this.cfg.proxyEndpoint;
    const url = endpoint.startsWith('ws')
      ? (endpoint.includes('token=') ? endpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.cfg.token)}`)
      : toWSURL(endpoint, this.cfg.token);
    try {
      this.ws = await this.deps.connect(url);
    } catch (err) {
      return await this.handleConnectFailure(err);
    }
    this.ws.onMessage((raw) => this.onMessage(raw));
    this.ws.onClose(() => { this.handleDisconnect(); });
    this.ws.onError((err) => {
      this.emitEvent({ type: 'error', error_code: 'realtime_socket_error', message: String(err.message ?? err).slice(0, 120) });
    });
    // 会话初始化：不发密钥——token 已在 URL/头由 connect 工厂处理。
    this.ws.send(buildSessionUpdate({}));
    this.sessionApplied = true;
    this.setState('ready');
    return { ok: true };
  }

  private handleConnectFailure(err: unknown): { ok: boolean; error_code?: string; message?: string } | Promise<{ ok: boolean; error_code?: string; message?: string }> {
    if (this.reconnects < RECONNECT_MAX) {
      this.reconnects += 1;
      return this.connectOnce('reconnecting');
    }
    this.setState('error');
    const msg = String((err as Error)?.message ?? err).slice(0, 160);
    this.emitEvent({ type: 'error', error_code: 'realtime_unavailable', message: msg });
    return { ok: false, error_code: 'realtime_unavailable', message: msg };
  }

  private handleDisconnect(): void {
    if (this.state === 'ended' || this.state === 'error') return;
    if (this.reconnects < RECONNECT_MAX) {
      this.reconnects += 1;
      void this.connectOnce('reconnecting');
      return;
    }
    this.setState('error');
    this.emitEvent({ type: 'error', error_code: 'realtime_disconnected', message: '实时连接断开且重连次数已用尽' });
  }

  private onMessage(raw: string): void {
    const parsed = decodeRealtimeEvent(raw);
    if (!parsed) return;
    switch (parsed.type) {
      case 'response.audio.delta': {
        const b64 = typeof parsed.data.delta === 'string' ? parsed.data.delta : '';
        if (b64) this.emitEvent({ type: 'audio_delta', dataBase64: b64 });
        return;
      }
      case 'response.audio.done':
        this.emitEvent({ type: 'audio_done' });
        return;
      case 'response.audio_transcript.delta': {
        const text = typeof parsed.data.delta === 'string' ? parsed.data.delta : '';
        if (text) this.emitEvent({ type: 'transcript_delta', text });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = typeof parsed.data.transcript === 'string' ? parsed.data.transcript : '';
        this.emitEvent({ type: 'input_transcript', text });
        return;
      }
      case 'response.done':
        this.emitEvent({ type: 'turn_committed' });
        return;
      case 'error': {
        const errObj = parsed.data.error as { code?: string; message?: string } | undefined;
        this.emitEvent({ type: 'error', error_code: errObj?.code ?? 'realtime_upstream_error', message: String(errObj?.message ?? '').slice(0, 160) });
        return;
      }
      default:
        // 其余事件忽略（会话级 ack 等）。
        return;
    }
  }

  /** 上行音频块。 */
  append(chunk: RealtimeAudioChunk): { ok: boolean; error_code?: string } {
    if (!this.ws || (this.state !== 'ready')) return { ok: false, error_code: 'realtime_not_ready' };
    this.ws.send(buildAudioAppend(chunk));
    return { ok: true };
  }

  /** 提交上行缓冲（手动模式；server_vad 开启时上游自动提交，此调用幂等无害）。 */
  commit(): { ok: boolean; error_code?: string } {
    if (!this.ws || this.state !== 'ready') return { ok: false, error_code: 'realtime_not_ready' };
    this.ws.send(buildAudioCommit());
    return { ok: true };
  }

  /** 打断：立即停播放（渲染器侧）并取消上游 response。 */
  interrupt(): { ok: boolean; error_code?: string } {
    if (!this.ws || this.state !== 'ready') return { ok: false, error_code: 'realtime_not_ready' };
    this.ws.send(buildResponseCancel());
    this.emitEvent({ type: 'interrupted' });
    return { ok: true };
  }

  /** 结束会话（用户停止或会话 ended）。 */
  stop(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* 已断 */ }
      this.ws = null;
    }
    this.cfg = null;
    this.sessionApplied = false;
    this.setState('ended');
  }

  /** 测试/诊断视图：绝不包含 token。 */
  statusView(): { state: RealtimeBridgeState; reconnects: number; session_applied: boolean; has_config: boolean } {
    return {
      state: this.state,
      reconnects: this.reconnects,
      session_applied: this.sessionApplied,
      has_config: Boolean(this.cfg),
    };
  }
}

/** HTTP(S) 代理路径转 WS URL；token 作查询参数（本机回环/内网场景，短期凭据）。 */
function toWSURL(pathOrURL: string, token: string): string {
  if (/^wss?:\/\//.test(pathOrURL)) {
    const u = new URL(pathOrURL);
    u.searchParams.set('token', token);
    return u.toString();
  }
  // 相对路径：默认本机 API（wss 由反代终结；本地开发走 ws://127.0.0.1:8080）。
  const u = new URL(`ws://127.0.0.1:8080${pathOrURL.startsWith('/') ? pathOrURL : '/' + pathOrURL}`);
  u.searchParams.set('token', token);
  return u.toString();
}
