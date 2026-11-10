-- +goose Up
-- A30b 片 2（用户拍板：账本存载荷+同步等待）：浏览器命令账本存执行载荷与回执结果。
-- payload：模型动作参数（服务端登记时落库，桌面执行器领取后据此派发到本机桥）；
-- result：扩展回执的结果载荷（receipt 时落库，模型同步等待读取）。
-- 两列允许 NULL：00089 时期的既有记录没有载荷/结果，如实保留空。
-- +goose StatementBegin
ALTER TABLE agent_browser_command ADD COLUMN payload JSONB;
ALTER TABLE agent_browser_command ADD COLUMN result JSONB;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE agent_browser_command DROP COLUMN IF EXISTS result;
ALTER TABLE agent_browser_command DROP COLUMN IF EXISTS payload;
-- +goose StatementEnd
