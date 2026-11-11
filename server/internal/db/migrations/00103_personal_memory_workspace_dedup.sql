-- +goose Up
-- D-175 / BE-01：个人记忆去重作用域改为 user+workspace（对齐 27 §11.1.1）。
-- 旧索引 uq_agent_personal_memory_active_hash (user_id, content_hash) 跨工作区互挡；
-- 新索引 (user_id, workspace_id, content_hash) 允许同 user 不同 workspace 各自独立。
-- 旧索引已禁止跨 workspace 的 candidate/active 同 hash，故「新索引创建失败」仅可能来自
-- 同 workspace 内脏数据；下面做同 workspace 防御性回填（保留最新 updated_at）。

-- 同 (user_id, workspace_id, content_hash) 多条 candidate/active：旧行转 deleted（清空正文）。
UPDATE agent_personal_memory
SET state = 'deleted', text = '', revision = revision + 1, updated_at = now()
FROM (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, workspace_id, content_hash
               ORDER BY updated_at DESC, created_at DESC, id DESC
           ) AS rn
    FROM agent_personal_memory
    WHERE state IN ('candidate', 'active')
) ranked
WHERE agent_personal_memory.id = ranked.id AND ranked.rn > 1;

DROP INDEX IF EXISTS uq_agent_personal_memory_active_hash;
CREATE UNIQUE INDEX uq_agent_personal_memory_active_hash
    ON agent_personal_memory(user_id, workspace_id, content_hash)
    WHERE state IN ('candidate', 'active');

-- +goose Down
-- 回退前若已产生跨 workspace 同 hash 的 candidate/active，旧索引会建失败——
-- 先按 (user_id, content_hash) 只保留最新一条，其余转 deleted。
UPDATE agent_personal_memory
SET state = 'deleted', text = '', revision = revision + 1, updated_at = now()
FROM (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, content_hash
               ORDER BY updated_at DESC, created_at DESC, id DESC
           ) AS rn
    FROM agent_personal_memory
    WHERE state IN ('candidate', 'active')
) ranked
WHERE agent_personal_memory.id = ranked.id AND ranked.rn > 1;

DROP INDEX IF EXISTS uq_agent_personal_memory_active_hash;
CREATE UNIQUE INDEX uq_agent_personal_memory_active_hash
    ON agent_personal_memory(user_id, content_hash)
    WHERE state IN ('candidate', 'active');
