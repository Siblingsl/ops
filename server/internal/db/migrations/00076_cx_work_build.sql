-- DEV-CX02：一次只读构建快照与受控产物索引；文件仍存于现有 DataDir。
-- +goose Up
CREATE TABLE work_build (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  work_id uuid NOT NULL REFERENCES work(id),
  basis_revision int NOT NULL CHECK (basis_revision > 0),
  targets text[] NOT NULL CHECK (cardinality(targets) BETWEEN 1 AND 5
    AND targets <@ ARRAY['wechat_html','stable_html','long_image','xhs_cards','cover_images']::text[]),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  params jsonb NOT NULL CHECK (jsonb_typeof(params)='object'),
  params_hash text NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','built','failed')),
  reusable boolean NOT NULL DEFAULT true,
  manifest jsonb,
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  acknowledgements jsonb NOT NULL DEFAULT '[]',
  error_code text,
  error_detail jsonb,
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  expires_at timestamptz,
  cleanup_state text NOT NULL DEFAULT 'active' CHECK (cleanup_state IN ('active','pending','done')),
  CHECK (deadline_at > created_at),
  CHECK ((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL)),
  CHECK (status<>'built' OR (manifest IS NOT NULL AND manifest_sha256 IS NOT NULL AND expires_at IS NOT NULL)),
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX work_build_idem ON work_build(work_id,source_hash,params_hash)
  WHERE reusable AND status IN ('running','built');
CREATE INDEX work_build_history ON work_build(work_id,created_at DESC,id DESC);
CREATE INDEX work_build_timeout ON work_build(deadline_at) WHERE status='running';

CREATE TABLE work_build_artifact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  build_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('html','stable_html','png','zip','json','csv')),
  name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 67108864),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width int CHECK (width > 0),
  height int CHECK (height > 0),
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (build_id,workspace_id) REFERENCES work_build(id,workspace_id) ON DELETE CASCADE,
  UNIQUE (build_id,name)
);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM work_build) OR EXISTS (SELECT 1 FROM work_build_artifact) THEN
    RAISE EXCEPTION '已存在构建快照或产物索引，拒绝回滚丢弃；请保留构建数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE work_build_artifact;
DROP TABLE work_build;
