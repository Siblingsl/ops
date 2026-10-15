-- D-117 / DEV-AG12：隔离工作区操作日志；无法可靠归属的历史记录保留为空。
-- +goose Up
ALTER TABLE audit_log
  ADD COLUMN workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;

UPDATE audit_log l SET workspace_id = COALESCE(
  (SELECT w.id FROM workspace w WHERE l.target_type = 'workspace' AND w.id::text = l.target_id),
  (SELECT i.workspace_id FROM workspace_invite i WHERE l.target_type = 'workspace_invite' AND i.id::text = l.target_id),
  (SELECT a.workspace_id FROM platform_account a WHERE l.target_type IN ('platform_account','account') AND a.id::text = l.target_id),
  (SELECT a.workspace_id FROM platform_account a JOIN topic t ON t.account_id = a.id WHERE l.target_type = 'topic' AND t.id::text = l.target_id),
  (SELECT a.workspace_id FROM work w JOIN platform_account a ON a.id = w.account_id WHERE l.target_type = 'work' AND w.id::text = l.target_id),
  (SELECT a.workspace_id FROM asset a WHERE l.target_type = 'asset' AND a.id::text = l.target_id),
  (SELECT m.workspace_id FROM material m WHERE l.target_type = 'material' AND m.id::text = l.target_id),
  (SELECT a.workspace_id FROM platform_account a JOIN account_memory m ON m.account_id = a.id WHERE l.target_type = 'account_memory' AND m.id::text = l.target_id),
  (SELECT a.workspace_id FROM platform_account a JOIN character_card c ON c.account_id = a.id WHERE l.target_type = 'character_card' AND c.id::text = l.target_id),
  (SELECT a.workspace_id FROM platform_account a JOIN style_sample s ON s.account_id = a.id WHERE l.target_type = 'style_sample' AND s.id::text = l.target_id),
  (SELECT p.workspace_id FROM model_provider p WHERE l.target_type = 'model_provider' AND p.id::text = l.target_id),
  (SELECT s.workspace_id FROM sensitive_word s WHERE l.target_type = 'sensitive_word' AND s.id::text = l.target_id),
  (SELECT p.workspace_id FROM work_section s JOIN work w ON w.id = s.work_id JOIN platform_account p ON p.id = w.account_id WHERE l.target_type = 'work_section' AND s.id::text = l.target_id),
  (SELECT p.workspace_id FROM platform_account p JOIN work w ON w.account_id = p.id JOIN work_version v ON v.work_id = w.id WHERE l.target_type = 'work_version' AND v.id::text = l.target_id),
  (SELECT p.workspace_id FROM platform_account p JOIN work w ON w.account_id = p.id JOIN comic_panel c ON c.work_id = w.id WHERE l.target_type = 'comic_panel' AND c.id::text = l.target_id),
  (SELECT p.workspace_id FROM platform_account p JOIN work w ON w.account_id = p.id JOIN work_card c ON c.work_id = w.id WHERE l.target_type = 'work_card' AND c.id::text = l.target_id),
  (SELECT p.workspace_id FROM platform_account p JOIN work w ON w.account_id = p.id JOIN check_run r ON r.work_id = w.id WHERE l.target_type = 'check_run' AND r.id::text = l.target_id),
  (SELECT p.workspace_id FROM platform_account p JOIN work w ON w.account_id = p.id JOIN check_run r ON r.work_id = w.id JOIN check_item i ON i.check_run_id = r.id WHERE l.target_type = 'check_item' AND i.id::text = l.target_id),
  (SELECT a.workspace_id FROM platform_account a JOIN push_record p ON p.account_id = a.id WHERE l.target_type = 'push_record' AND p.id::text = l.target_id),
  (SELECT s.workspace_id FROM app_setting s
    WHERE l.target_type = 'app_setting' AND s.key = l.target_id
      AND (SELECT count(*) FROM app_setting x WHERE x.key = l.target_id) = 1
    LIMIT 1),
  (SELECT (array_agg(m.workspace_id))[1] FROM workspace_member m
    WHERE l.target_type = 'user' AND m.user_id::text = l.target_id
    HAVING count(DISTINCT m.workspace_id) = 1)
)
WHERE l.workspace_id IS NULL;

CREATE INDEX audit_log_workspace_created ON audit_log (workspace_id, created_at DESC);

-- +goose Down
DROP INDEX audit_log_workspace_created;
ALTER TABLE audit_log DROP COLUMN workspace_id;
