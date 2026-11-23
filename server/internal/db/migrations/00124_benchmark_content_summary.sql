-- +goose Up
-- REF41 I2-D1：补竞对笔记的原文摘要输入，让 AI 初拆真正基于作品内容。
-- 只保存用户提供的摘要（最多 4000 码点），不保存全文，避免全文复制。
-- 00123 已由 I2 使用；本迁移取下一可用号 00124（D-205）。

ALTER TABLE benchmark_note
  ADD COLUMN content_summary text NOT NULL DEFAULT ''
    CHECK (char_length(content_summary) <= 4000);

-- +goose Down
-- 只移除原文摘要列，不触碰 00123 的拆解字段或既有结构字段。
ALTER TABLE benchmark_note
  DROP COLUMN IF EXISTS content_summary;
