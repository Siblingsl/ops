-- DEV-AW03 / D-152：初始化历史未读水位，并为工作台搜索与活动列表提供索引。
-- 旧消息在功能启用前视为已读；降级只移除索引，保留既有 read marker。

-- +goose Up
UPDATE agent_conversation c
SET read_upto_message_seq = COALESCE((
  SELECT max(m.seq)
  FROM agent_message m
  WHERE m.conversation_id = c.id
    AND m.role IN ('assistant','action_result','system_note')
), 0)
WHERE c.read_upto_message_seq = 0 AND NOT c.force_unread;

CREATE INDEX agent_conversation_active_list
  ON agent_conversation (workspace_id, user_id, (pinned_at IS NULL), pinned_at DESC, last_message_at DESC, id DESC)
  WHERE archived_at IS NULL;
CREATE INDEX agent_message_search_trgm
  ON agent_message USING gin (content gin_trgm_ops)
  WHERE role IN ('user','assistant','action_result','system_note') AND content <> '';

-- +goose Down
DROP INDEX agent_message_search_trgm;
DROP INDEX agent_conversation_active_list;
