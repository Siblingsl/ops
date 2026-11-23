-- +goose Up
-- REF41 A1：反谎报三闸。run 收尾记录“声称—证据”检查结果：
-- fabrication_nudges 是无证据声称的纠正次数；outcome 区分 partial/failed；
-- demo 标记模拟模型演示；final_check 存检查摘要；raw_final_text 存改写前原文。

ALTER TABLE agent_run ADD COLUMN fabrication_nudges int NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN outcome text NOT NULL DEFAULT 'completed'
  CHECK (outcome IN ('completed','partial','failed','stopped','awaiting_confirmation','awaiting_input'));
ALTER TABLE agent_run ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE agent_run ADD COLUMN final_check jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(final_check)='object');
ALTER TABLE agent_run ADD COLUMN raw_final_text text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE agent_run DROP COLUMN IF EXISTS raw_final_text;
ALTER TABLE agent_run DROP COLUMN IF EXISTS final_check;
ALTER TABLE agent_run DROP COLUMN IF EXISTS demo;
ALTER TABLE agent_run DROP COLUMN IF EXISTS outcome;
ALTER TABLE agent_run DROP COLUMN IF EXISTS fabrication_nudges;
