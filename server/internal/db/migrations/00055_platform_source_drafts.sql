-- D-133 / DEV-AS07：从已同步平台镜像逐篇创建草稿时保留来源版本。

-- +goose Up
ALTER TABLE work
  ADD COLUMN platform_source_mirror_id uuid REFERENCES platform_work_mirror(id) ON DELETE SET NULL,
  ADD COLUMN platform_source_content_revision int CHECK (platform_source_content_revision IS NULL OR platform_source_content_revision >= 0),
  ADD COLUMN platform_source_mirror_revision bigint CHECK (platform_source_mirror_revision IS NULL OR platform_source_mirror_revision > 0);

CREATE INDEX work_platform_source_mirror
  ON work (platform_source_mirror_id) WHERE platform_source_mirror_id IS NOT NULL;

-- +goose Down
-- 来源关系属于新建草稿的出处记录；存在时拒绝静默丢弃。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM work WHERE platform_source_mirror_id IS NOT NULL
      OR platform_source_content_revision IS NOT NULL OR platform_source_mirror_revision IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back platform source draft provenance while data exists';
  END IF;
END
$$;
-- +goose StatementEnd

DROP INDEX work_platform_source_mirror;
ALTER TABLE work
  DROP COLUMN platform_source_mirror_id,
  DROP COLUMN platform_source_content_revision,
  DROP COLUMN platform_source_mirror_revision;
