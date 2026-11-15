-- +goose Up
-- CF-DESK-03 桌面消费接线（P0-3，2026-11-16）：桌面主进程轮询领取待执行 MCP 调用。
-- 账本状态维持 D-186 P4 拍板的 5 态不扩；dispatched 语义含「待执行」，桌面领取用
-- claimed_at CAS（多桌面并发领取同一调用时只有先到的执行者拿到载荷），回执幂等
-- 由既有 receipt 的终态幂等 / 异结果 409 兜底。契约 §2.5：连接所有权归桌面
-- McpHostManager，服务端不持有 socket、不 spawn 进程。
ALTER TABLE agent_plugin_call
    ADD COLUMN claimed_at timestamptz;
CREATE INDEX idx_agent_plugin_call_pending ON agent_plugin_call(state, created_at)
    WHERE state = 'dispatched';

-- +goose Down
ALTER TABLE agent_plugin_call DROP COLUMN IF EXISTS claimed_at;
DROP INDEX IF EXISTS idx_agent_plugin_call_pending;
