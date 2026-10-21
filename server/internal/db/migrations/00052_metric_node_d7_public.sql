-- D7 语义的统一读取入口（20 文档 §8.4）。
--
-- 背景：`work_metric_d7` 被 8 个消费点直接查询，§8.4 要求它们迁到统一投影入口。
-- 但两者选点规则**不等价**：
--   - `work_metric_d7`：有 `day_offset <= 7` 时取其中**最大**的；否则兜底取 `> 7` 的最小者。
--   - `metric_node_public(work, 7)`：只在 `day_offset <= 7` 里选，**不兜底**。
-- 直接替换会让"只有 >7 数据"的作品从有值变成无值，改变现有报表。
--
-- 因此新增 `metric_node_d7_public(p_work_id)`，保留 d7 的兜底语义，
-- 同时输出与 `metric_node_public` 相同的质量过滤、单位与精确性字段。
-- 消费点改调它之后视图 `work_metric_d7` 才可能下线。

-- +goose Up
-- 单作品版本（保留 d7 兜底语义）。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_node_d7_public(p_work_id uuid)
RETURNS TABLE (
  work_id uuid, metric_id uuid, source text, day_offset int, actual_day_offset int, node_exact boolean,
  captured_at timestamptz, observed_at timestamptz, as_of_at timestamptz,
  reads int, read_unit text, likes int, wows int, favorites int, comments int, shares int, share_unit text,
  interactions int, follows_gained int, impressions bigint, quality_state text, observation_id uuid,
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
    ORDER BY m.work_id, m.source,
      -- 与 work_metric_d7 完全一致的选点顺序：
      -- 1) 优先 day_offset <= 7（排 0）；无则 day_offset IS NULL（排 1）；再否则 >7（排 2）
      CASE WHEN m.day_offset <= 7 THEN 0 WHEN m.day_offset IS NULL THEN 1 ELSE 2 END,
      -- 2) 在 <=7 组内取**最大** day_offset（-day_offset 升序 = day_offset 降序）；
      --    在 >7 组内取**最小** day_offset（day_offset 升序）。
      CASE WHEN m.day_offset <= 7 THEN -m.day_offset ELSE m.day_offset END,
      metric_source_rank(m.source),
      m.captured_at DESC
  )
  SELECT
    p_work_id, picked.id, picked.source, picked.day_offset, picked.day_offset,
    (picked.day_offset = 7),
    picked.captured_at, picked.observed_at, picked.as_of_at,
    picked.reads, picked.read_unit, picked.likes, picked.wows, picked.favorites, picked.comments,
    picked.shares, picked.share_unit,
    -- 与 work_metric_d7 视图完全同口径：全部为 NULL 时返回 NULL，否则把已知项相加。
    CASE WHEN picked.likes IS NULL AND picked.wows IS NULL AND picked.favorites IS NULL
              AND picked.comments IS NULL AND picked.shares IS NULL THEN NULL
         ELSE coalesce(picked.likes,0)+coalesce(picked.wows,0)+coalesce(picked.favorites,0)
              +coalesce(picked.comments,0)+coalesce(picked.shares,0) END,
    picked.follows_gained, picked.impressions, picked.quality_state,
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

-- 批量版本：一次返回多个作品的 D7 视图，供统计类消费点使用（避免 N+1）。
-- 依赖上面已创建的单作品函数。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_node_d7_public_all(p_work_ids uuid[])
RETURNS TABLE (
  work_id uuid, metric_id uuid, source text, day_offset int, actual_day_offset int, node_exact boolean,
  captured_at timestamptz, observed_at timestamptz, as_of_at timestamptz,
  reads int, read_unit text, likes int, wows int, favorites int, comments int, shares int, share_unit text,
  interactions int, follows_gained int, impressions bigint, quality_state text, observation_id uuid,
  missing_fields text[], metric_meta jsonb
)
LANGUAGE sql STABLE AS $$
  SELECT r.*
  FROM unnest(p_work_ids) AS w(id)
  CROSS JOIN LATERAL metric_node_d7_public(w.id) AS r
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS metric_node_d7_public_all(uuid[]);
DROP FUNCTION IF EXISTS metric_node_d7_public(uuid);
-- +goose StatementEnd
