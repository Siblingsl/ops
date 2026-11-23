-- +goose Up
-- TL-06：子智能体并行。27 §11.3.3 允许单父 run 同时运行 2 个子 run；原
-- agent_run_one_active 按 conversation_id 唯一会禁止同会话第二个子 run，
-- 导致第二项永远停在 queued。主 run（interactive/goal/routine）仍保持
-- 同会话唯一活动，delegation 子 run 不占用主 run 的活动位。
DROP INDEX IF EXISTS agent_run_one_active;
CREATE UNIQUE INDEX agent_run_one_active ON agent_run (conversation_id)
  WHERE status IN ('queued','running') AND execution_origin <> 'delegation';

-- +goose Down
-- 回滚前必须确认没有并行的活动 run，否则旧唯一索引无法重建。
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM agent_run
        WHERE status IN ('queued','running')
        GROUP BY conversation_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION '存在并行活动 run，不能回滚 agent_run_one_active';
    END IF;
END $$;
-- +goose StatementEnd
DROP INDEX IF EXISTS agent_run_one_active;
CREATE UNIQUE INDEX agent_run_one_active ON agent_run (conversation_id)
  WHERE status IN ('queued','running');
