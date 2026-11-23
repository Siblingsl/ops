-- +goose Up
-- REF41 A5：流程技能蒸馏与发布技能模板。
-- skill 扩 origin 枚举（distilled/builtin），新增结构化 procedure（≤12 步）、
-- procedure_version、source_run_id、distill_confidence、replay_policy。
-- 内置发布技能仍走 Go 静态注册表（skills.Builtin），不入库；本迁移只加列。

ALTER TABLE skill DROP CONSTRAINT skill_origin_check;
ALTER TABLE skill ADD CONSTRAINT skill_origin_check
  CHECK (origin IN ('manual','imported','copied','distilled','builtin'));

ALTER TABLE skill ADD COLUMN procedure jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(procedure)='array');
ALTER TABLE skill ADD COLUMN procedure_version integer NOT NULL DEFAULT 0
  CHECK (procedure_version >= 0);
ALTER TABLE skill ADD COLUMN source_run_id uuid
  REFERENCES agent_run(id) ON DELETE SET NULL;
ALTER TABLE skill ADD COLUMN distill_confidence numeric(3,2)
  CHECK (distill_confidence IS NULL OR (distill_confidence >= 0 AND distill_confidence <= 1));
ALTER TABLE skill ADD COLUMN replay_policy text NOT NULL DEFAULT 'suggest_only'
  CHECK (replay_policy IN ('suggest_only'));

CREATE INDEX skill_source_run ON skill (source_run_id) WHERE source_run_id IS NOT NULL;

-- 技能回放需要新触发来源：只建计划，不直接执行工具。
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue','goal','compact','routine','skill_replay'));

-- +goose Down
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue','goal','compact','routine'));

DROP INDEX IF EXISTS skill_source_run;

ALTER TABLE skill DROP COLUMN replay_policy;
ALTER TABLE skill DROP COLUMN distill_confidence;
ALTER TABLE skill DROP COLUMN source_run_id;
ALTER TABLE skill DROP COLUMN procedure_version;
ALTER TABLE skill DROP COLUMN procedure;

ALTER TABLE skill DROP CONSTRAINT skill_origin_check;
ALTER TABLE skill ADD CONSTRAINT skill_origin_check
  CHECK (origin IN ('manual','imported','copied'));
