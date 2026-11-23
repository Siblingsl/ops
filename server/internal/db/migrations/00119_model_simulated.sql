-- +goose Up
-- REF41 A2：模拟模型标记。simulated=true 的供应商生产环境拒绝解析（提示管理员
-- 更换 provider）；开发环境允许运行但强制 demo=true。价格字段属 A8 同批迁移口径
-- 的前半（A8 落价格值，字段在此批先建）。

ALTER TABLE model_provider ADD COLUMN simulated boolean NOT NULL DEFAULT false;
ALTER TABLE model_provider ADD COLUMN input_price_micros_per_1k bigint;
ALTER TABLE model_provider ADD COLUMN output_price_micros_per_1k bigint;
ALTER TABLE model_provider ADD COLUMN price_currency text NOT NULL DEFAULT 'CNY';
ALTER TABLE model_provider ADD COLUMN price_updated_at timestamptz;

-- +goose Down
ALTER TABLE model_provider DROP COLUMN IF EXISTS price_updated_at;
ALTER TABLE model_provider DROP COLUMN IF EXISTS price_currency;
ALTER TABLE model_provider DROP COLUMN IF EXISTS output_price_micros_per_1k;
ALTER TABLE model_provider DROP COLUMN IF EXISTS input_price_micros_per_1k;
ALTER TABLE model_provider DROP COLUMN IF EXISTS simulated;
