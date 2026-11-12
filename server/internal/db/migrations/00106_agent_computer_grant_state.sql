-- +goose Up
-- DEV-CU P1-4（docs/36 §5，D-188）：补齐 pending → active 与 revoking → revoked 的设备确认闭环。
-- expected_revision 供 P4 命令账本做审批版本 CAS（本包只加列，不消费）。
ALTER TABLE agent_computer_grant
    ADD COLUMN device_ack_pending boolean NOT NULL DEFAULT false,
    ADD COLUMN expected_revision text NOT NULL DEFAULT '',
    ADD COLUMN after_event_seq bigint;

ALTER TABLE agent_computer_grant DROP CONSTRAINT agent_computer_grant_state;
ALTER TABLE agent_computer_grant ADD CONSTRAINT agent_computer_grant_state CHECK (
    state IN ('pending','active','revoking','revoked','expired'));

-- +goose Down
-- 旧 CHECK 不含 revoking，必须先收敛在途撤销记录，否则约束回加会失败（不是静默跳过）。
ALTER TABLE agent_computer_grant DROP CONSTRAINT agent_computer_grant_state;
UPDATE agent_computer_grant
   SET state = 'revoked',
       revoked_at = COALESCE(revoked_at, now()),
       device_ack_pending = false
 WHERE state = 'revoking';
ALTER TABLE agent_computer_grant ADD CONSTRAINT agent_computer_grant_state CHECK (
    state IN ('pending','active','revoked','expired'));
ALTER TABLE agent_computer_grant
    DROP COLUMN device_ack_pending,
    DROP COLUMN expected_revision,
    DROP COLUMN after_event_seq;
