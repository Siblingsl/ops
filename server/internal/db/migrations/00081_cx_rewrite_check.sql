-- DEV-CX12 / FR-CX-15：改写度检查（category=rewrite）与单项处理理由。
-- rewrite 项的 resolution 沿用既有枚举（acknowledged/modified）；理由存 resolution_note（20..500 码点）。
-- +goose Up
ALTER TABLE check_item
  DROP CONSTRAINT check_item_category_check,
  ADD CONSTRAINT check_item_category_check CHECK (category IN ('format', 'sensitive', 'fact', 'ai_disclosure', 'similarity', 'ad_law', 'rewrite'));
ALTER TABLE check_item ADD COLUMN IF NOT EXISTS resolution_note text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE check_item DROP COLUMN IF EXISTS resolution_note;
ALTER TABLE check_item
  DROP CONSTRAINT check_item_category_check,
  ADD CONSTRAINT check_item_category_check CHECK (category IN ('format', 'sensitive', 'fact', 'ai_disclosure', 'similarity', 'ad_law'));
