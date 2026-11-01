-- DEV-CX13-D / 24 §4.10.2：模型上下文窗口元数据登记（发送前预算检查的前提）。
-- 由用户按厂商文档显式登记；NULL 表示未登记、不做发送前检查（保留上游 413 映射兜底），不猜测厂商容量。
-- +goose Up
ALTER TABLE model_provider ADD COLUMN context_window_tokens int CHECK (context_window_tokens IS NULL OR context_window_tokens >= 1024);

-- +goose Down
ALTER TABLE model_provider DROP COLUMN context_window_tokens;
