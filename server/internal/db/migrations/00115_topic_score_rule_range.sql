-- REF41 I4：六维选题评分规则总分 0-120，复用 content_diagnosis.rule_score。
-- 旧约束为 0-60（DEV-CX11 二维诊断）；放宽后不影响旧诊断的 0-55 值。
-- +goose Up
ALTER TABLE content_diagnosis DROP CONSTRAINT IF EXISTS content_diagnosis_rule_score_check;
ALTER TABLE content_diagnosis ADD CONSTRAINT content_diagnosis_rule_score_check CHECK (rule_score BETWEEN 0 AND 120);

-- +goose Down
ALTER TABLE content_diagnosis DROP CONSTRAINT IF EXISTS content_diagnosis_rule_score_check;
-- 旧诊断上限恢复为 60；NOT VALID 避免已存在的 61-120 历史评分阻塞结构回滚。
ALTER TABLE content_diagnosis ADD CONSTRAINT content_diagnosis_rule_score_check CHECK (rule_score BETWEEN 0 AND 60) NOT VALID;
