// P0-3（CF-DESK-03 桌面消费接线）：MCP 调用执行器单测。
// 全部走内存桩：pending/claim/receipt 与连接启动均为注入函数，不发任何真实 HTTP，
// 不 spawn 任何 MCP 服务器。服务端三步协议的行为由 Go 定向测试覆盖。
const assert = require('node:assert/strict');
const test = require('node:test');

const { McpCallExecutor, localMcpToolName } = require('../.build/mcp-call-executor.js');

function row(overrides = {}) {
  return {
    id: 'c1', connection_id: 'conn-1', tool_name: 'mcp__connshort__echo',
    args: { text: 'hi' }, transport: 'stdio', command: 'node',
    conn_args: ['server.js'], cwd: 'C:\\tmp',
    ...overrides
  };
}

function makeExecutor(calls, hooks = {}) {
  const events = [];
  const startedConns = [];
  const executor = new McpCallExecutor({
    listPending: async () => ({ calls: calls.shift() ?? [] }),
    claim: async (id) => {
      events.push(['claim', id]);
      return { claimed: hooks.claimed ? hooks.claimed(id) : true };
    },
    receipt: async (id, body) => {
      events.push(['receipt', id, body.state, body.error_code ?? '', body.result ?? null]);
      return {};
    },
    connections: async () => [],
    host: () => ({
      get: (id) => ({ callTool: async (name, args) => ({ echoed: { name, args } }) }),
      stop: (id) => startedConns.push(['stop', id]),
    }),
    startConnection: async (input) => {
      startedConns.push(['start', input.connectionId, input.transport]);
      if (hooks.startFail) throw new Error(hooks.startFail);
      return {};
    },
    log: (line) => events.push(['log', line]),
  });
  return { executor, events, startedConns };
}

test('P0-3 三步协议：claim 成功才执行，receipt succeeded 带结果', async () => {
  const { executor, events, startedConns } = makeExecutor([[row()]]);
  const executed = await executor.pollOnce();
  assert.equal(executed, 1);
  assert.deepEqual(events[0], ['claim', 'c1']);
  assert.deepEqual(startedConns[0], ['start', 'conn-1', 'stdio'], '连接未启动时先启动');
  const receipt = events.find((e) => e[0] === 'receipt');
  assert.equal(receipt[2], 'succeeded');
  assert.deepEqual(receipt[4], { echoed: { name: 'echo', args: { text: 'hi' } } }, 'MCP 侧只收本地工具名');
});

test('P0-3 claim=false（并发被他人抢先）：不执行不回执', async () => {
  const { executor, events, startedConns } = makeExecutor([[row()]], { claimed: () => false });
  const executed = await executor.pollOnce();
  assert.equal(executed, 0);
  assert.equal(startedConns.length, 0, '未领取不得启动连接');
  assert.equal(events.filter((e) => e[0] === 'receipt').length, 0);
});

test('P0-3 执行失败：receipt failed 带稳定错误码，不中断后续轮询', async () => {
  const { executor, events } = makeExecutor([[row()], []], { startFail: 'spawn 失败' });
  const executed = await executor.pollOnce();
  assert.equal(executed, 1);
  const receipt = events.find((e) => e[0] === 'receipt');
  assert.equal(receipt[2], 'failed');
  assert.equal(receipt[3], 'mcp_tool_error');
});

test('P0-3 连接配置变化：先停旧实例再重启（契约 §2.5 复用语义）', async () => {
  const { executor, startedConns } = makeExecutor([
    [row()], [row({ command: 'python' })],
  ]);
  await executor.pollOnce();
  await executor.pollOnce();
  assert.deepEqual(startedConns.map((e) => e[0]), ['start', 'stop', 'start']);
});

test('P0-3 工具名形状：mcp__<conn>__<tool> 取末段，形状不符拒绝执行', async () => {
  assert.equal(localMcpToolName('mcp__connshort__echo'), 'echo');
  assert.equal(localMcpToolName('not_mcp'), null);
  assert.equal(localMcpToolName('mcp__conn__'), null);
  assert.equal(localMcpToolName('mcp__conn'), null);
  const { executor, events } = makeExecutor([[row({ tool_name: 'mcp__bad' })]]);
  await executor.pollOnce();
  const receipt = events.find((e) => e[0] === 'receipt');
  assert.equal(receipt[2], 'failed', '形状不符按 failed 回执，不留 dispatched 挂起');
});

test('R11-D2: plugin_mcp 闸门关闭时轮询失败日志只记一条，恢复后重新告警', async () => {
  const logs = [];
  let failing = true;
  const executor = new McpCallExecutor({
    listPending: async () => {
      if (failing) throw new Error('该工作台功能尚未开放');
      return { calls: [] };
    },
    claim: async () => ({ claimed: false }),
    receipt: async () => ({}),
    connections: async () => [],
    host: () => null,
    startConnection: async () => ({}),
    log: (line) => logs.push(line),
  });
  const waitFor = async (predicate, ms = 200) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return predicate();
  };

  executor.start(5, 5);
  await waitFor(() => logs.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logs.length, 1, '连续同样的失败只能记一条日志');
  assert.match(logs[0], /该工作台功能尚未开放/);

  failing = false;
  await waitFor(() => executor.lastErrorText() === '');
  failing = true;
  await waitFor(() => logs.length >= 2);
  assert.equal(logs.filter((line) => line.includes('poll failed')).length, 2, '恢复后再次失败必须重新记录');
  executor.stop();
});
