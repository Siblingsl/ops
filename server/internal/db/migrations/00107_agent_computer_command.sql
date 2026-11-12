-- +goose Up
-- DEV-CU P4-1（docs/36 §5 / §4.10，D-188）：电脑控制命令账本表。
-- 结构对齐 agent_browser_command 先例（00089）；写类动作绑定 D-117 卡片，
-- approval_hash 是「一次批准」的内容 hash；generation 与 grant 同值做审批版本 CAS。
-- 租户冗余列（workspace_id/user_id/conversation_id）对齐 D-036：所有查询必须带租户条件。

CREATE TABLE agent_computer_command (
    id uuid PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES agent_computer_grant(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    run_id uuid,
    request_id uuid NOT NULL,
    card_id uuid,
    approval_hash varchar(64),
    action_kind varchar(32) NOT NULL,
    target_ref varchar(64) NOT NULL DEFAULT '',
    payload jsonb,
    result jsonb,
    input_hash varchar(64) NOT NULL,
    state varchar(24) NOT NULL DEFAULT 'queued',
    disposition jsonb,
    requires_confirmation boolean NOT NULL DEFAULT false,
    generation bigint NOT NULL DEFAULT 0,
    deadline_at timestamptz,
    dispatched_at timestamptz,
    receipt_hash varchar(64),
    error_code varchar(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_computer_command_state CHECK (
        state IN ('queued','dispatched','succeeded','failed','unknown_outcome','cancelled')),
    -- 幂等：同 grant 同 request 只有一条；同编号不同 input_hash 由应用层 409。
    CONSTRAINT uq_agent_computer_command_request UNIQUE (grant_id, request_id)
);
-- sweep：超期 dispatched 扫描（state, deadline_at）
CREATE INDEX idx_agent_computer_command_sweep ON agent_computer_command(state, deadline_at);
-- pending 清单：同 grant 队列按时间序
CREATE INDEX idx_agent_computer_command_grant ON agent_computer_command(grant_id, state, created_at);
-- run 内同步等待：run 维度取命令
CREATE INDEX idx_agent_computer_command_run ON agent_computer_command(run_id, created_at);

-- +goose Down
DELETE FROM agent_computer_command;
DROP TABLE IF EXISTS agent_computer_command;
