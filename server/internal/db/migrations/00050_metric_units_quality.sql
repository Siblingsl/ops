-- +goose Up
-- D-129 / 20 文档 §8.5、§9：指标快照新增口径、质量与观测指针，并建立唯一读取入口。
-- 旧行一律回填 unknown，不得默认成人数（§9.1）。

ALTER TABLE metric_snapshot
  ADD COLUMN read_unit text NOT NULL DEFAULT 'unknown' CHECK (read_unit IN ('users', 'times', 'unknown')),
  ADD COLUMN share_unit text NOT NULL DEFAULT 'unknown' CHECK (share_unit IN ('users', 'times', 'unknown')),
  ADD COLUMN quality_state text NOT NULL DEFAULT 'approved'
    CHECK (quality_state IN ('approved', 'held', 'superseded')),
  ADD COLUMN observation_id uuid REFERENCES platform_metric_observation(id) ON DELETE RESTRICT,
  ADD COLUMN corrects_observation_id uuid REFERENCES platform_metric_observation(id) ON DELETE SET NULL,
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN as_of_at timestamptz,
  ADD COLUMN metric_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 来源新增浏览器通路。旧来源全部保留：历史补数、平台故障与官方接口能力各有独立场景。
ALTER TABLE metric_snapshot DROP CONSTRAINT metric_snapshot_source_check;
ALTER TABLE metric_snapshot ADD CONSTRAINT metric_snapshot_source_check
  CHECK (source IN ('wechat_api', 'wechat_browser', 'xhs_browser', 'file', 'screenshot', 'paste', 'manual'));

-- 同一作品同一来源的「无节点」快照只能有一条（§8.3）。
CREATE UNIQUE INDEX metric_snapshot_work_source_no_node
  ON metric_snapshot (work_id, source) WHERE day_offset IS NULL;

-- 来源排序收敛为一处，视图与 Go 侧都从这里取，避免新增 source 后 array_position 返回 NULL 排到最后。
-- +goose StatementBegin
CREATE FUNCTION metric_source_rank(p_source text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_source
    WHEN 'wechat_api' THEN 0
    WHEN 'wechat_browser' THEN 1
    WHEN 'xhs_browser' THEN 1
    WHEN 'file' THEN 2
    WHEN 'screenshot' THEN 3
    WHEN 'paste' THEN 4
    WHEN 'manual' THEN 5
  END
$$;
-- +goose StatementEnd

-- 未登记的 source 在正式读取中直接拒绝，不靠 NULL 排序。
-- +goose StatementBegin
CREATE FUNCTION metric_source_supported(p_source text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT metric_source_rank(p_source) IS NOT NULL
$$;
-- +goose StatementEnd

-- 唯一读取入口：按节点参数化，排除 held/superseded，输出单位、实际日数与精确性（§8.4）。
-- node 为 null 时返回该作品每个来源的最新一条（供“最近一次已知值”展示）。
-- +goose StatementBegin
CREATE FUNCTION metric_node_public(p_work_id uuid, p_node int)
RETURNS TABLE (
  work_id uuid, metric_id uuid, source text, day_offset int, actual_day_offset int, node_exact boolean,
  captured_at timestamptz, observed_at timestamptz, as_of_at timestamptz,
  reads int, read_unit text, likes int, wows int, favorites int, comments int, shares int, share_unit text,
  follows_gained int, impressions bigint, quality_state text, observation_id uuid,
  missing_fields text[], metric_meta jsonb
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT DISTINCT ON (m.work_id, m.source)
      m.*
    FROM metric_snapshot m
    WHERE m.work_id = p_work_id
      AND m.quality_state = 'approved'
      AND metric_source_supported(m.source)
      AND (p_node IS NULL OR (m.day_offset IS NOT NULL AND m.day_offset <= p_node))
    ORDER BY m.work_id, m.source,
      -- 优先真实节点；其次最接近且早于目标节点的记录。
      CASE WHEN p_node IS NULL THEN 0 WHEN m.day_offset = p_node THEN 0 ELSE 1 END,
      CASE WHEN p_node IS NULL THEN 0 ELSE abs(m.day_offset - p_node) END,
      metric_source_rank(m.source),
      m.captured_at DESC
  )
  SELECT
    p_work_id, picked.id, picked.source, picked.day_offset, picked.day_offset,
    (p_node IS NULL OR picked.day_offset = p_node),
    picked.captured_at, picked.observed_at, picked.as_of_at,
    picked.reads, picked.read_unit, picked.likes, picked.wows, picked.favorites, picked.comments,
    picked.shares, picked.share_unit, picked.follows_gained, picked.impressions, picked.quality_state,
    picked.observation_id,
    ARRAY(
      SELECT key FROM (VALUES
        ('reads', picked.reads), ('likes', picked.likes), ('wows', picked.wows),
        ('favorites', picked.favorites), ('comments', picked.comments), ('shares', picked.shares),
        ('follows_gained', picked.follows_gained), ('impressions', picked.impressions)
      ) AS v(key, val) WHERE val IS NULL
    ),
    picked.metric_meta
  FROM picked
  ORDER BY metric_source_rank(picked.source);
END
$$;
-- +goose StatementEnd

-- work_metric_d7 保留给未迁移的旧查询，但补质量过滤、单位与精确性标志（§8.4）。
CREATE OR REPLACE VIEW work_metric_d7 AS
SELECT DISTINCT ON (m.work_id)
  m.work_id, m.id AS metric_id, m.day_offset, m.source, m.captured_at,
  m.reads, m.likes, m.wows, m.favorites, m.comments, m.shares, m.follows_gained,
  CASE WHEN m.likes IS NULL AND m.wows IS NULL AND m.favorites IS NULL AND m.comments IS NULL AND m.shares IS NULL THEN NULL
    ELSE coalesce(m.likes,0)+coalesce(m.wows,0)+coalesce(m.favorites,0)+coalesce(m.comments,0)+coalesce(m.shares,0) END AS interactions,
  m.impressions,
  m.read_unit, m.share_unit, m.quality_state,
  (m.day_offset = 7) AS node_exact,
  m.as_of_at, m.observed_at
FROM metric_snapshot m
WHERE m.quality_state = 'approved' AND metric_source_supported(m.source)
ORDER BY m.work_id,
  CASE WHEN m.day_offset <= 7 THEN 0 WHEN m.day_offset IS NULL THEN 1 ELSE 2 END,
  CASE WHEN m.day_offset <= 7 THEN -m.day_offset ELSE m.day_offset END,
  metric_source_rank(m.source),
  m.captured_at DESC;

-- 修订：按 §8.5 总表逐列加入 read_unit/share_unit/quality_state/observation_id/corrects_observation_id/
-- observed_at/as_of_at/metric_meta；impressions 沿用 00047 的决定。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.work_id, NEW.captured_at, NEW.reads, NEW.impressions, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.follows_gained, NEW.note, NEW.source, NEW.day_offset, NEW.external_id,
      NEW.read_unit, NEW.share_unit, NEW.quality_state, NEW.observation_id, NEW.corrects_observation_id,
      NEW.observed_at, NEW.as_of_at, NEW.metric_meta)
     IS DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.impressions, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.follows_gained, OLD.note, OLD.source, OLD.day_offset, OLD.external_id,
      OLD.read_unit, OLD.share_unit, OLD.quality_state, OLD.observation_id, OLD.corrects_observation_id,
      OLD.observed_at, OLD.as_of_at, OLD.metric_meta) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- 偏好输入：只收会改变偏好结果的列（§8.5）。impressions、观测指针、时点与 metric_meta 不加入；
-- read_unit/share_unit/quality_state 加入。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_pref_input_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_account uuid;
  new_account uuid;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.work_id, NEW.captured_at, NEW.reads, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.source, NEW.day_offset,
      NEW.read_unit, NEW.share_unit, NEW.quality_state)
     IS NOT DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.source, OLD.day_offset,
      OLD.read_unit, OLD.share_unit, OLD.quality_state) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT account_id INTO old_account FROM work WHERE id=OLD.work_id AND deleted_at IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT account_id INTO new_account FROM work WHERE id=NEW.work_id AND deleted_at IS NULL;
  END IF;
  IF old_account IS NOT NULL THEN
    PERFORM bump_pref_input_revision(old_account);
  END IF;
  IF new_account IS NOT NULL AND new_account IS DISTINCT FROM old_account THEN
    PERFORM bump_pref_input_revision(new_account);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- 节点偏移：浏览器来源信任显式 day_offset（§9.4 二选一，这里选“信任显式 offset”），
-- 否则平台历史值会被触发器按 captured_at 改成当天节点。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_fill_offset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.day_offset IS NOT NULL AND (
       TG_OP = 'INSERT'
       OR NEW.source IN ('wechat_api', 'wechat_browser', 'xhs_browser')
     ) THEN
    RETURN NEW;
  END IF;
  SELECT metric_day_offset(NEW.captured_at, w.published_at) INTO NEW.day_offset FROM work w WHERE w.id = NEW.work_id;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- 新增列与视图承载口径与质量信息，回退会丢失“这条数据是什么单位、是否被排除”。
-- 只要出现过新来源或非默认质量/单位，就拒绝回退，避免旧二进制把人数与次数混算。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM metric_snapshot
             WHERE source IN ('wechat_browser', 'xhs_browser')
                OR quality_state <> 'approved'
                OR read_unit <> 'unknown'
                OR share_unit <> 'unknown') THEN
    RAISE EXCEPTION 'cannot roll back metric units and quality while new-source or classified rows exist';
  END IF;
END
$$;
-- +goose StatementEnd

DROP VIEW work_metric_d7;
CREATE VIEW work_metric_d7 AS
SELECT DISTINCT ON (m.work_id)
  m.work_id, m.id AS metric_id, m.day_offset, m.source, m.captured_at,
  m.reads, m.likes, m.wows, m.favorites, m.comments, m.shares, m.follows_gained,
  CASE WHEN m.likes IS NULL AND m.wows IS NULL AND m.favorites IS NULL AND m.comments IS NULL AND m.shares IS NULL THEN NULL
    ELSE coalesce(m.likes,0)+coalesce(m.wows,0)+coalesce(m.favorites,0)+coalesce(m.comments,0)+coalesce(m.shares,0) END AS interactions,
  m.impressions
FROM metric_snapshot m
ORDER BY m.work_id,
  CASE WHEN m.day_offset <= 7 THEN 0 WHEN m.day_offset IS NULL THEN 1 ELSE 2 END,
  CASE WHEN m.day_offset <= 7 THEN -m.day_offset ELSE m.day_offset END,
  array_position(ARRAY['wechat_api','file','screenshot','paste','manual'], m.source),
  m.captured_at DESC;

-- 先还原触发器函数，再删列：否则函数体里对新列的引用会阻止 DROP COLUMN。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.work_id, NEW.captured_at, NEW.reads, NEW.impressions, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.follows_gained, NEW.note, NEW.source, NEW.day_offset, NEW.external_id)
     IS DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.impressions, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.follows_gained, OLD.note, OLD.source, OLD.day_offset, OLD.external_id) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_pref_input_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_account uuid;
  new_account uuid;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.work_id, NEW.captured_at, NEW.reads, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.source, NEW.day_offset)
     IS NOT DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.source, OLD.day_offset) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT account_id INTO old_account FROM work WHERE id=OLD.work_id AND deleted_at IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT account_id INTO new_account FROM work WHERE id=NEW.work_id AND deleted_at IS NULL;
  END IF;
  IF old_account IS NOT NULL THEN
    PERFORM bump_pref_input_revision(old_account);
  END IF;
  IF new_account IS NOT NULL AND new_account IS DISTINCT FROM old_account THEN
    PERFORM bump_pref_input_revision(new_account);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_fill_offset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.day_offset IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.source = 'wechat_api') THEN
    RETURN NEW;
  END IF;
  SELECT metric_day_offset(NEW.captured_at, w.published_at) INTO NEW.day_offset FROM work w WHERE w.id = NEW.work_id;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

DROP FUNCTION metric_node_public(uuid, int);
DROP FUNCTION metric_source_supported(text);
DROP FUNCTION metric_source_rank(text);
DROP INDEX metric_snapshot_work_source_no_node;

ALTER TABLE metric_snapshot DROP CONSTRAINT metric_snapshot_source_check;
ALTER TABLE metric_snapshot ADD CONSTRAINT metric_snapshot_source_check
  CHECK (source IN ('wechat_api', 'file', 'screenshot', 'paste', 'manual'));

ALTER TABLE metric_snapshot
  DROP COLUMN metric_meta, DROP COLUMN as_of_at, DROP COLUMN observed_at,
  DROP COLUMN corrects_observation_id, DROP COLUMN observation_id,
  DROP COLUMN quality_state, DROP COLUMN share_unit, DROP COLUMN read_unit;
