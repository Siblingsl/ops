-- +goose Up
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_platform_check;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_content_format_check;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_platform_format_check;

ALTER TABLE platform_account ADD CONSTRAINT platform_account_platform_check
  CHECK (platform IN ('wechat_mp', 'xhs', 'toutiao'));
ALTER TABLE platform_account ADD CONSTRAINT platform_account_content_format_check
  CHECK (content_format IN ('long_article', 'image_note', 'comic', 'qa_article', 'briefing', 'list_note', 'card_post', 'script', 'micro_post'));
ALTER TABLE platform_account ADD CONSTRAINT platform_account_platform_format_check CHECK (
  (platform = 'wechat_mp' AND content_format IN ('long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic')) OR
  (platform = 'xhs' AND content_format IN ('image_note', 'list_note', 'card_post', 'script', 'comic')) OR
  (platform = 'toutiao' AND content_format IN ('long_article', 'micro_post'))
);

-- +goose Down
-- Existing Toutiao accounts are user data. Refuse rollback instead of deleting or orphaning them.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_account WHERE platform = 'toutiao') THEN
    RAISE EXCEPTION 'cannot roll back Toutiao platform migration while Toutiao accounts exist';
  END IF;
END
$$;
-- +goose StatementEnd

ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_platform_format_check;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_platform_check;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_content_format_check;
ALTER TABLE platform_account ADD CONSTRAINT platform_account_platform_check
  CHECK (platform IN ('wechat_mp', 'xhs'));
ALTER TABLE platform_account ADD CONSTRAINT platform_account_content_format_check
  CHECK (content_format IN ('long_article', 'image_note', 'comic', 'qa_article', 'briefing', 'list_note', 'card_post', 'script'));
ALTER TABLE platform_account ADD CONSTRAINT platform_account_platform_format_check CHECK (
  (platform = 'wechat_mp' AND content_format IN ('long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic')) OR
  (platform = 'xhs' AND content_format IN ('image_note', 'list_note', 'card_post', 'script', 'comic'))
);
