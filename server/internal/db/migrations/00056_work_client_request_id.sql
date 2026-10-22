-- NW-A2 / DEV-NW01：新建作品的幂等键。
-- 同一账号下同一个 Idempotency-Key 只产生一篇作品；双击、超时重试都复用已有作品。

-- +goose Up
ALTER TABLE work ADD COLUMN client_request_id text;
CREATE UNIQUE INDEX work_account_client_request_id
  ON work (account_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- +goose Down
DROP INDEX work_account_client_request_id;
ALTER TABLE work DROP COLUMN client_request_id;
