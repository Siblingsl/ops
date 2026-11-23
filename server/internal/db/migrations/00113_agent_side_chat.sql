-- +goose Up
-- FN-12（docs/38 §12.4、docs/90 D-190）：旁问是独立会话，继承主对话创建时的只读快照，
-- 不共享主对话目标/预算，不写业务数据；默认关闭，由 side_chat 开关控制入口。
ALTER TABLE agent_conversation
  ADD COLUMN kind text NOT NULL DEFAULT 'main'
    CHECK (kind IN ('main','fork','side')),
  ADD COLUMN side_context text NOT NULL DEFAULT '',
  ADD COLUMN side_token_budget integer NOT NULL DEFAULT 20000
    CHECK (side_token_budget BETWEEN 1000 AND 100000);

-- 既有 fork 行按原字段回填类型；side 行只能由新接口创建，历史数据不存在。
UPDATE agent_conversation SET kind='fork'
 WHERE parent_id IS NOT NULL AND fork_upto_seq IS NOT NULL;

CREATE INDEX agent_conversation_side_parent
  ON agent_conversation(parent_id, created_at DESC)
  WHERE kind='side';

-- +goose Down
-- 已有旁问时回滚会丢失只读快照与类型标签，拒绝并提示前滚修复。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_conversation WHERE kind='side') THEN
    RAISE EXCEPTION '已有旁问会话，拒绝回滚丢失快照；请保留数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP INDEX agent_conversation_side_parent;
ALTER TABLE agent_conversation
  DROP COLUMN side_token_budget,
  DROP COLUMN side_context,
  DROP COLUMN kind;
