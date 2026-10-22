-- NW-A8 / DEV-NW01：记录作品创建人，补齐"谁建的"（此前只存在于审计日志）。

-- +goose Up
ALTER TABLE work ADD COLUMN created_by uuid REFERENCES app_user(id) ON DELETE SET NULL;
CREATE INDEX work_created_by ON work (created_by) WHERE created_by IS NOT NULL;

-- +goose Down
DROP INDEX work_created_by;
ALTER TABLE work DROP COLUMN created_by;
