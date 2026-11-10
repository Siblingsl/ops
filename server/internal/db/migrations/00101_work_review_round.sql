-- DEV-A20（CK-03 审阅轮次）：记录作品进入「待审阅」的轮次。
-- 语义：每次从 ready 进入 reviewing 时 +1；退回/通过不清零，便于检查页显示「第 N 轮」。
-- 旧二进制不读该列；默认 0 对历史数据表示「未记录轮次」，不回填。
-- +goose Up
ALTER TABLE work ADD COLUMN review_round integer NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE work DROP COLUMN review_round;
