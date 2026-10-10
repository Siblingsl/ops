-- +goose Up
-- D-048：账号类型扩展（qa_article/briefing/list_note/card_post/script）与 type_note。
-- work.content_format 保持无约束的作品形态快照；历史数据不做转换。
-- 00001 中两个内联 CHECK 的自动命名已核对：platform_account_content_format_check / platform_account_check。

ALTER TABLE platform_account ADD COLUMN IF NOT EXISTS type_note text NOT NULL DEFAULT '';

ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_content_format_check;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_check;

ALTER TABLE platform_account ADD CONSTRAINT platform_account_content_format_check
  CHECK (content_format IN ('long_article', 'image_note', 'comic', 'qa_article', 'briefing', 'list_note', 'card_post', 'script'));
ALTER TABLE platform_account ADD CONSTRAINT platform_account_platform_format_check CHECK (
  (platform = 'wechat_mp' AND content_format IN ('long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic')) OR
  (platform = 'xhs' AND content_format IN ('image_note', 'list_note', 'card_post', 'script', 'comic'))
);

-- D-048 图文卡片（card_post）：卡片 = 作品段落 + 逐卡 AI 配图，打包与图片消息按卡片图取材。
CREATE TABLE work_card (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id        uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  section_id     uuid NOT NULL REFERENCES work_section(id) ON DELETE CASCADE,
  position       int NOT NULL,
  image_asset_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, section_id)
);
CREATE INDEX work_card_work ON work_card(work_id, position);

-- +goose Down
DROP TABLE work_card;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_platform_format_check;
ALTER TABLE platform_account DROP CONSTRAINT IF EXISTS platform_account_content_format_check;
ALTER TABLE platform_account ADD CONSTRAINT platform_account_content_format_check
  CHECK (content_format IN ('long_article', 'image_note', 'comic'));
ALTER TABLE platform_account ADD CHECK (
  (platform = 'wechat_mp' AND content_format IN ('long_article', 'comic')) OR
  (platform = 'xhs' AND content_format IN ('image_note', 'comic'))
);
ALTER TABLE platform_account DROP COLUMN IF EXISTS type_note;
