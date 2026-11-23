-- +goose Up
-- REF41 A8：单 run 成本账。价格以“微分/千 token”落库，避免浮点误差；
-- run 结束时按当时的 provider 价格计算 cost_micros，历史 run 不回溯。
ALTER TABLE agent_run ADD COLUMN cost_micros bigint;
ALTER TABLE agent_run ADD COLUMN cost_currency text NOT NULL DEFAULT 'CNY';
ALTER TABLE agent_run ADD CONSTRAINT agent_run_cost_micros_nonnegative
  CHECK (cost_micros IS NULL OR cost_micros >= 0);
ALTER TABLE agent_run ADD CONSTRAINT agent_run_cost_currency_nonempty
  CHECK (cost_currency <> '');

-- A2 已建价格字段但没有非负约束；补齐约束，避免负单价把成本算成负数。
ALTER TABLE model_provider ADD CONSTRAINT model_provider_input_price_micros_nonnegative
  CHECK (input_price_micros_per_1k IS NULL OR input_price_micros_per_1k >= 0);
ALTER TABLE model_provider ADD CONSTRAINT model_provider_output_price_micros_nonnegative
  CHECK (output_price_micros_per_1k IS NULL OR output_price_micros_per_1k >= 0);

-- 兼容旧字段：已有 provider 的“元/千 token”价格回填为微分/千 token；
-- 只回填空值，不覆盖 A2 已写入的新字段。
UPDATE model_provider
SET input_price_micros_per_1k = round(price_per_1k_prompt * 1000000)::bigint
WHERE input_price_micros_per_1k IS NULL
  AND price_per_1k_prompt IS NOT NULL
  AND price_per_1k_prompt >= 0;

UPDATE model_provider
SET output_price_micros_per_1k = round(price_per_1k_completion * 1000000)::bigint
WHERE output_price_micros_per_1k IS NULL
  AND price_per_1k_completion IS NOT NULL
  AND price_per_1k_completion >= 0;

-- +goose Down
ALTER TABLE model_provider DROP CONSTRAINT IF EXISTS model_provider_output_price_micros_nonnegative;
ALTER TABLE model_provider DROP CONSTRAINT IF EXISTS model_provider_input_price_micros_nonnegative;
ALTER TABLE agent_run DROP CONSTRAINT IF EXISTS agent_run_cost_currency_nonempty;
ALTER TABLE agent_run DROP CONSTRAINT IF EXISTS agent_run_cost_micros_nonnegative;
ALTER TABLE agent_run DROP COLUMN IF EXISTS cost_currency;
ALTER TABLE agent_run DROP COLUMN IF EXISTS cost_micros;
