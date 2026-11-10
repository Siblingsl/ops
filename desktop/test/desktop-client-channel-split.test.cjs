'use strict';
// DT-08 片 A（docs/33 §10.7 / §10.8 DT-08；≡DEV-S02）：desktop-client.ts 通道组拆分。
// 缺陷（拆分前）：desktop-client.ts 2184 行单类持有通道/配置/模型/路由/平台五域职责，
// 通道组（connect/openChannel/控制帧/数据帧/worker/流控）占约 620 行。
// 修复：client/channel.ts 以原型混入承载通道方法，DesktopClient 继承之；
// 私有字段声明与公有 API 形状不变，行为逐字节搬移。源码契约由本文件锁定。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('DT-08A: client/channel.ts 存在且承载通道方法（connect/openChannel/handleControlFrame）', () => {
  const channelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'channel.ts'), 'utf8');
  for (const symbol of ['connect(', 'openChannel(', 'handleControlFrame(', 'handleDataFrame(', 'handleWorkerMessage(', 'sendControl(', 'closeProtocol(']) {
    assert.ok(channelSource.includes(symbol), `channel.ts 应包含 ${symbol}`);
  }
});

test('DT-08A: DesktopClient 继承通道混入，desktop-client.ts 不再内联通道方法体', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-client.ts'), 'utf8');
  assert.ok(clientSource.includes('ChannelMixin'), 'DesktopClient 应继承 ChannelMixin');
  assert.ok(!clientSource.includes('private async openChannel('), 'openChannel 应已迁出 desktop-client.ts');
  assert.ok(!clientSource.includes('private handleControlFrame('), 'handleControlFrame 应已迁出');
  assert.ok(!clientSource.includes('private handleWorkerMessage('), 'handleWorkerMessage 应已迁出');
  // 公有 API 形状不变：connect/disconnect/suppressReconnectForTest 签名保留在 client 或混入。
  assert.ok(/async connect\(automaticRetry = false\): Promise<void>/.test(clientSource + fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'channel.ts'), 'utf8')),
    'connect(automaticRetry) 签名必须保持');
});

test('DT-08A: 通道常量与协议消息形状搬移后保持不变（PROTOCOL_VERSION/请求上限）', () => {
  const channelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'channel.ts'), 'utf8');
  assert.ok(channelSource.includes('PROTOCOL_VERSION'), '协议版本常量应在 channel.ts');
  assert.ok(channelSource.includes('MAX_REQUEST_BYTES'), '请求体上限常量应在 channel.ts');
  // 关键协议断言逐字保留（防拆分时丢防线）。
  assert.ok(channelSource.includes("throw new Error('服务端桌面 AI 请求参数无效。')"), 'openRequest 参数校验错误消息保留');
  assert.ok(channelSource.includes("throw new Error('服务端响应流控额度无效。')"), '响应流控校验错误消息保留');
});
