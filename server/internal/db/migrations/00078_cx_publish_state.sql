-- DEV-CX13-A：发布里程碑是本地进度投影，公开事实仍由 work 保持唯一真源。
-- +goose Up
CREATE TABLE work_publish_state (
  work_id uuid PRIMARY KEY REFERENCES work(id),
  state text NOT NULL CHECK (state IN ('submitted','scheduled','public','registered')),
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  submitted_ref jsonb,
  scheduled_at timestamptz,
  schedule_evidence jsonb,
  registered_metric_id uuid REFERENCES metric_snapshot(id) ON DELETE SET NULL,
  registered_metric_revision int,
  publication_revision int NOT NULL DEFAULT 0,
  since timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CHECK (state <> 'scheduled' OR (scheduled_at IS NOT NULL AND schedule_evidence IS NOT NULL))
);

CREATE TABLE work_publish_state_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES work(id),
  event_kind text NOT NULL CHECK (event_kind IN ('transition','correction','import','invalidation')),
  from_state text CHECK (from_state IN ('submitted','scheduled','public','registered')),
  to_state text NOT NULL CHECK (to_state IN ('submitted','scheduled','public','registered')),
  state_version int NOT NULL CHECK (state_version > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  actor uuid REFERENCES app_user(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id,state_version),
  UNIQUE (work_id,idempotency_key)
);
CREATE INDEX work_publish_event_history ON work_publish_state_event(work_id,state_version DESC);

-- 历史公开作品只导入一条观察事件。发布时间/URL 继续从 work 读取，绝不补造提交记录或发布时间。
INSERT INTO work_publish_state (work_id,state,version,publication_revision,since)
SELECT id,'public',1,publish_revision,now()
FROM work
WHERE status='published';

INSERT INTO work_publish_state_event (work_id,event_kind,from_state,to_state,state_version,evidence,note,
  idempotency_key,request_hash,actor,at)
SELECT w.id,'import',NULL,'public',1,'{}'::jsonb,'历史公开事实导入',
  'import:'||w.id::text,
  md5('publish-state-import:'||w.id::text)||md5('publish-state-import-v1:'||w.id::text),
  NULL,now()
FROM work w
WHERE w.status='published';

-- +goose Down
-- 转换事件和人工留证不能丢弃后静默回到旧状态。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM work_publish_state_event) OR EXISTS (SELECT 1 FROM work_publish_state) THEN
    RAISE EXCEPTION '发布进度台账含历史或当前状态，拒绝回滚丢弃；请保留数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP INDEX work_publish_event_history;
DROP TABLE work_publish_state_event;
DROP TABLE work_publish_state;
