-- +goose Up
-- REF41 C3：PPTX/DOCX 确定性导出。work_build.targets 扩展 pptx/docx；
-- work_build_artifact.kind 扩展 pptx/docx。约束名与结构以 00076_cx_work_build.sql
-- 实际定义为准（targets text[] 内联 CHECK、artifact kind ANY ARRAY CHECK）。

ALTER TABLE work_build DROP CONSTRAINT work_build_targets_check;
ALTER TABLE work_build ADD CONSTRAINT work_build_targets_check
  CHECK (cardinality(targets) BETWEEN 1 AND 5
    AND targets <@ ARRAY['wechat_html','stable_html','long_image','xhs_cards','cover_images','pptx','docx']::text[]);

ALTER TABLE work_build_artifact DROP CONSTRAINT work_build_artifact_kind_check;
ALTER TABLE work_build_artifact ADD CONSTRAINT work_build_artifact_kind_check
  CHECK (kind = ANY (ARRAY['html','stable_html','png','zip','json','csv','pptx','docx']::text[]));

-- +goose Down
ALTER TABLE work_build DROP CONSTRAINT work_build_targets_check;
ALTER TABLE work_build ADD CONSTRAINT work_build_targets_check
  CHECK (cardinality(targets) BETWEEN 1 AND 5
    AND targets <@ ARRAY['wechat_html','stable_html','long_image','xhs_cards','cover_images']::text[]);

ALTER TABLE work_build_artifact DROP CONSTRAINT work_build_artifact_kind_check;
ALTER TABLE work_build_artifact ADD CONSTRAINT work_build_artifact_kind_check
  CHECK (kind = ANY (ARRAY['html','stable_html','png','zip','json','csv']::text[]));
