-- DEV-CX12 / FR-CX-18：对标账号库与笔记拆解库（两层库 + 四问 fit_score）。
-- DDL 按 24 文档 8.3 节登记的契约实施；删除本期用 archive 替代，不物理删除。
-- +goose Up
CREATE TABLE benchmark_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id),
  platform text NOT NULL CHECK (platform IN ('wechat_mp','xhs','toutiao')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  url text NOT NULL DEFAULT '', normalized_url text NOT NULL DEFAULT '',
  positioning text NOT NULL DEFAULT '',
  follower_band text NOT NULL DEFAULT 'unknown' CHECK (follower_band IN ('unknown','<1k','1k-1w','1w-10w','10w+')),
  entry text CHECK (entry IN ('search','recommend','topic','tool')),
  answers jsonb NOT NULL DEFAULT '{}',
  fit_score int CHECK (fit_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','dropped')),
  revision int NOT NULL DEFAULT 1 CHECK (revision > 0),
  migration_source_key text UNIQUE,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,workspace_id)
);
CREATE UNIQUE INDEX benchmark_target_url ON benchmark_target(account_id,platform,normalized_url)
  WHERE normalized_url<>'';
CREATE INDEX benchmark_target_list ON benchmark_target(account_id,archived_at,fit_score DESC,id);
CREATE TABLE benchmark_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  target_id uuid NOT NULL,
  url text NOT NULL DEFAULT '', normalized_url text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  structure jsonb NOT NULL CHECK (jsonb_typeof(structure)='object'),
  structure_hash text NOT NULL,
  metrics_snapshot jsonb NOT NULL DEFAULT '{}',
  takeaways jsonb NOT NULL DEFAULT '[]', not_borrowable jsonb NOT NULL DEFAULT '[]',
  captured_at timestamptz,
  revision int NOT NULL DEFAULT 1 CHECK (revision > 0),
  ai_call_id uuid REFERENCES ai_call(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (target_id,workspace_id) REFERENCES benchmark_target(id,workspace_id)
);
CREATE UNIQUE INDEX benchmark_note_url ON benchmark_note(target_id,normalized_url) WHERE normalized_url<>'';
CREATE INDEX benchmark_note_list ON benchmark_note(target_id,created_at DESC,id DESC);

-- 旧 account_strategy.benchmarks（{name,note,links[]}）纯结构回填：
-- 不改变旧行、不代答四问（answers 置空、fit_score=NULL、status=candidate）；
-- 稳定来源键 strategy_id+数组index+原值hash 保证重跑幂等；缺 URL 也可导入（normalized_url=''）。
-- URL 规范化（去 fragment/默认端口）在服务端写入路径统一执行，迁移只存原始值。
INSERT INTO benchmark_target (workspace_id, account_id, platform, name, url, normalized_url,
  positioning, answers, fit_score, status, migration_source_key)
SELECT p.workspace_id, s.account_id, p.platform,
  left(CASE WHEN btrim(COALESCE(b.b->>'name','')) = '' THEN '（未命名对标账号）' ELSE b.b->>'name' END, 100),
  COALESCE((SELECT x FROM jsonb_array_elements_text(COALESCE(b.b->'links','[]'::jsonb)) x LIMIT 1), ''),
  '',
  '',
  '{}'::jsonb, NULL, 'candidate',
  s.id::text || ':' || b.idx || ':' || md5(COALESCE(b.b::text,''))
FROM account_strategy s
JOIN platform_account p ON p.id = s.account_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.benchmarks,'[]'::jsonb)) WITH ORDINALITY AS b(b, idx)
WHERE NOT EXISTS (
  SELECT 1 FROM benchmark_target t
  WHERE t.migration_source_key = s.id::text || ':' || b.idx || ':' || md5(COALESCE(b.b::text,''))
);

-- +goose Down
-- 对标库与拆解笔记是用户沉淀数据，不可通过回滚删除；已有数据时必须前滚修复。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM benchmark_note) THEN
    RAISE EXCEPTION '对标拆解笔记含记录，拒绝回滚丢弃；请保留记录并前滚修复';
  END IF;
  IF EXISTS (SELECT 1 FROM benchmark_target) THEN
    RAISE EXCEPTION '对标账号库含记录，拒绝回滚丢弃；请保留记录并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE benchmark_note;
DROP TABLE benchmark_target;
