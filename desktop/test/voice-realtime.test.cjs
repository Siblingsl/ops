'use strict';
// DEV-AI27-16 第六批（A2）：realtime 桥契约测试（node --test；WebSocket 由 fake 工厂注入）。
// 覆盖：信封编解码、session.update 首包、audio append/commit/interrupt 转发、
// 下行 audio/transcript/error 事件解析、断线重连 ≤3 次后转 error、statusView 零 token。

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RealtimeBridge,
  encodeRealtimeEvent,
  decodeRealtimeEvent,
  buildSessionUpdate,
  buildAudioAppend,
  buildAudioCommit,
  buildResponseCancel,
  REALTIME_UPSTREAM_SAMPLE_RATE,
  REALTIME_DOWNSTREAM_SAMPLE_RATE,
} = require('../.build/voice-realtime.js');

/** fake WS 工厂：记录发出的信封、可手动注入服务端消息/断开。 */
function fakeBridge() {
  const sent = [];
  let onMessage = null;
  let onClose = null;
  let onError = null;
  let connectCalls = 0;
  let failConnects = 0;
  const deps = {
    connect: async () => {
      connectCalls += 1;
      if (failConnects > 0 && connectCalls <= failConnects) {
        throw new Error('connect refused');
      }
      return {
        send: (raw) => sent.push(JSON.parse(raw)),
        close: () => { if (onClose) onClose(1000, 'client'); },
        onMessage: (cb) => { onMessage = cb; },
        onClose: (cb) => { onClose = cb; },
        onError: (cb) => { onError = cb; },
      };
    },
    now: () => Date.now(),
  };
  return {
    deps, sent,
    get onMessage() { return onMessage; },
    serverSend: (raw) => { if (onMessage) onMessage(raw); },
    serverClose: () => { if (onClose) onClose(1006, 'lost'); },
    setFailConnects: (n) => { failConnects = n; connectCalls = 0; },
    getConnectCalls: () => connectCalls,
  };
}

const CFG = { sessionID: 'sess-1', token: 'tok-secret-not-a-real-key', proxyEndpoint: 'ws://127.0.0.1:8080/realtime-ws?token=x', model: 'rt-model', provider: 'rt-provider' };

test('A2: 信封编解码（session.update 含采样率契约与转写开启）', () => {
  const raw = buildSessionUpdate({ voice: 'alloy' });
  const env = JSON.parse(raw);
  assert.equal(env.type, 'session.update');
  assert.equal(env.session.input_audio_format.sample_rate, REALTIME_UPSTREAM_SAMPLE_RATE);
  assert.equal(env.session.output_audio_format.sample_rate, REALTIME_DOWNSTREAM_SAMPLE_RATE);
  assert.ok(env.session.input_audio_transcription, '转写必须开启（V08 字幕）');
  assert.ok(!raw.includes('tok-secret'), 'session.update 不含会话凭据');
  // 上行/打断信封
  assert.equal(JSON.parse(buildAudioCommit()).type, 'input_audio_buffer.commit');
  assert.equal(JSON.parse(buildResponseCancel()).type, 'response.cancel');
  assert.equal(JSON.parse(buildAudioAppend({ dataBase64: 'QUJD' })).audio, 'QUJD');
  // 解码容错
  assert.equal(decodeRealtimeEvent('not-json'), null);
  assert.equal(decodeRealtimeEvent('{"no_type":1}'), null);
  assert.equal(decodeRealtimeEvent(encodeRealtimeEvent('response.audio.delta', { delta: 'AA==' })).type, 'response.audio.delta');
});

test('A2: start → session.update → ready；append/commit/interrupt 转发', async () => {
  const fake = fakeBridge();
  const bridge = new RealtimeBridge(fake.deps);
  const result = await bridge.start(CFG);
  assert.equal(result.ok, true);
  assert.equal(bridge.state, 'ready');
  assert.equal(fake.sent[0].type, 'session.update', '首包必须是 session.update');
  assert.equal(bridge.append({ dataBase64: 'QUJD' }).ok, true);
  assert.equal(fake.sent[fake.sent.length - 1].type, 'input_audio_buffer.append');
  assert.equal(bridge.commit().ok, true);
  assert.equal(bridge.interrupt().ok, true);
  assert.equal(fake.sent[fake.sent.length - 1].type, 'response.cancel');
  // not_ready 拒绝
  bridge.stop();
  assert.equal(bridge.append({ dataBase64: 'QQ==' }).error_code, 'realtime_not_ready');
});

test('A2: 下行事件解析（audio_delta/transcript/input_transcript/response.done/error）', async () => {
  const fake = fakeBridge();
  const bridge = new RealtimeBridge(fake.deps);
  const events = [];
  bridge.on('event', (ev) => events.push(ev));
  await bridge.start(CFG);
  fake.serverSend(JSON.stringify({ type: 'response.audio.delta', delta: 'AAEB' }));
  fake.serverSend(JSON.stringify({ type: 'response.audio_transcript.delta', delta: '你好' }));
  fake.serverSend(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '用户说的话' }));
  fake.serverSend(JSON.stringify({ type: 'response.done' }));
  fake.serverSend(JSON.stringify({ type: 'error', error: { code: 'bad_voice', message: 'voice 不存在' } }));
  fake.serverSend('garbage-not-json');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('audio_delta'));
  assert.ok(types.includes('transcript_delta'));
  assert.ok(types.includes('input_transcript'));
  assert.ok(types.includes('turn_committed'));
  const err = events.find((e) => e.type === 'error');
  assert.equal(err.error_code, 'bad_voice');
  assert.equal(err.message, 'voice 不存在');
  bridge.stop();
});

test('A2: 连接失败重试 ≤3 次后转 error（realtime_unavailable）', async () => {
  const fake = fakeBridge();
  fake.setFailConnects(99);
  const bridge = new RealtimeBridge(fake.deps);
  const result = await bridge.start(CFG);
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'realtime_unavailable');
  assert.equal(bridge.state, 'error');
  assert.equal(fake.getConnectCalls(), 4, '首次 + 3 次重连');
  // statusView 零 token
  const view = JSON.stringify(bridge.statusView());
  assert.ok(!view.includes('tok-secret'), 'statusView 不得含会话凭据');
});

test('A2: 中途断线自动重连（≤3 次），恢复后 ready；连断用尽转 error', async () => {
  const fake = fakeBridge();
  const bridge = new RealtimeBridge(fake.deps);
  await bridge.start(CFG);
  assert.equal(bridge.state, 'ready');
  // 断开一次 → 重连成功
  fake.serverClose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bridge.state, 'ready', '重连后应恢复 ready');
  assert.equal(fake.getConnectCalls(), 2);
  // 再断 3 次（每次等重连完成）：第 1/2 次仍恢复，第 3 次用尽转 error
  for (let i = 0; i < 3; i += 1) {
    fake.serverClose();
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(bridge.state, 'error', '重连 3 次用尽后转 error');
  bridge.stop();
});

test('A2: start 忙碌拒绝（已有活动会话）', async () => {
  const fake = fakeBridge();
  const bridge = new RealtimeBridge(fake.deps);
  await bridge.start(CFG);
  const second = await bridge.start({ ...CFG, sessionID: 'sess-2' });
  assert.equal(second.ok, false);
  assert.equal(second.error_code, 'realtime_bridge_busy');
  bridge.stop();
});

test('A2: 优先使用服务端签发的绝对 proxyURL，并补上 token', async () => {
  const urls = [];
  const deps = {
    connect: async (url) => {
      urls.push(url);
      return { send() {}, close() {}, onMessage() {}, onClose() {}, onError() {} };
    },
    now: () => Date.now(),
  };
  const bridge = new RealtimeBridge(deps);
  const result = await bridge.start({
    ...CFG,
    proxyURL: 'wss://ops.example.com/api/v1/agent/voice-sessions/sess-1/realtime-ws',
  });
  assert.equal(result.ok, true);
  assert.equal(urls[0], 'wss://ops.example.com/api/v1/agent/voice-sessions/sess-1/realtime-ws?token=tok-secret-not-a-real-key');
});
