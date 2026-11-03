-- DEV-CX13-C：FR-CX-19 选题库存维度。保留 topic.status 的既有创建/采用事实，
-- stock_status 是独立五态库存维度，不把原 status 换枚举。
-- Q-CX-06（90 D-165）：旧 pending 无核验证据 → idea 且 verified_at 保持 NULL（unknown），
-- 逐题核验后才进新排期；adopted → used，历史缺 used_at 保留 NULL 不按 created_at 伪造；
-- dropped → dropped。迁移不产生任何 legacy 豁免标记，核验门禁对存量题同样生效。
-- +goose Up
ALTER TABLE topic
  ADD COLUMN stock_status text NOT NULL DEFAULT 'idea'
    CHECK (stock_status IN ('idea', 'verified', 'ready', 'used', 'dropped')),
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN verify_note text NOT NULL DEFAULT '',
  ADD COLUMN used_at timestamptz,
  ADD COLUMN stock_reason text NOT NULL DEFAULT '';

UPDATE topic SET stock_status = CASE status
  WHEN 'adopted' THEN 'used'
  WHEN 'dropped' THEN 'dropped'
  ELSE 'idea' END;

-- 水位配置挂既有 account_profile（24 §8.9），不新建第二份配置存储。
-- DEFAULT '{}' 表示「未配置」：GET 不回填假配置，水位计算由服务端回退设计默认 12/6。
ALTER TABLE account_profile
  ADD COLUMN topic_stock_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  -- 已有核验/排期/采用时刻的存量不允许静默丢弃；前滚修复后才能回滚。
  IF EXISTS (SELECT 1 FROM topic WHERE verified_at IS NOT NULL OR used_at IS NOT NULL OR stock_status NOT IN ('idea', 'used', 'dropped')) THEN
    RAISE EXCEPTION '选题库存已有核验/排期数据，拒绝回滚丢弃；请保留 stock 维度并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE topic
  DROP COLUMN IF EXISTS stock_status,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verified_by,
  DROP COLUMN IF EXISTS verify_note,
  DROP COLUMN IF EXISTS used_at,
  DROP COLUMN IF EXISTS stock_reason;
ALTER TABLE account_profile DROP COLUMN IF EXISTS topic_stock_policy;
