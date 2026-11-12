-- +goose Up
-- CF-P2-CXEF-04（docs/24 FR-CX-23：effective_from 按账号时区）：账号级 IANA 时区。
-- 空/未知 = 缺省 Asia/Shanghai（既有口径不变）；由应用层 time.LoadLocation 校验，
-- 库层只存文本，避免 PG 时区名集合与 Go tzdata 差异造成写入失败。
ALTER TABLE account_profile
  ADD COLUMN timezone text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE account_profile
  DROP COLUMN timezone;
